import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseSpecKitTasks,
  TaskRecordError,
} from "../../../src/speckit/task-records.js";
import { sealTaskGraph } from "../../../src/speckit/seal-task-graph.js";
import { semanticHash } from "../../../src/speckit/semantic-hash.js";
import {
  artifactPaths,
  exactTaskDocumentFixture,
  exactTaskDocumentV2Fixture,
  malformedTaskDocumentFixture,
  planningProjectFixture,
  type MalformedTaskKind,
} from "../../support/planning-fixtures.js";

it("parses the exact visible grammar and ignores only checkbox state", () => {
  const unchecked = exactTaskDocumentFixture({ checkbox: " " });
  const checked = exactTaskDocumentFixture({ checkbox: "x" });
  expect(parseSpecKitTasks(unchecked)).toEqual(parseSpecKitTasks(checked));
  expect(parseSpecKitTasks(unchecked)[0]).toMatchObject({
    id: "T001",
    phase: "Setup",
    labels: ["US1"],
    parallelEligible: true,
    dependsOn: [],
    acceptanceRefs: ["FR-001"],
    ownedPaths: ["src/parser.ts"],
  });
});

it("rejects metadata that disagrees with the visible task definition", () => {
  expect(() =>
    parseSpecKitTasks(
      exactTaskDocumentFixture({ metadataOwnedPath: "src/wrong.ts" }),
    ),
  ).toThrow(/metadata does not match visible task/);
});

it.each([
  "missing_metadata_delimiter",
  "duplicate_json_key",
  "unknown_visible_syntax",
  "metadata_task_order_mismatch",
  "duplicate_set_member",
  "non_posix_path",
] as const)("rejects malformed task contract %s", (kind: MalformedTaskKind) => {
  expect(() => parseSpecKitTasks(malformedTaskDocumentFixture(kind))).toThrow(
    TaskRecordError,
  );
});

it("parses the exact v2 visible complexity syntax and metadata assessment", () => {
  const document = exactTaskDocumentV2Fixture();
  expect(document).toContain(
    '| complexity=standard | why="Touches parser and CLI contract" | deps=',
  );
  const tasks = parseSpecKitTasks(document);
  expect(tasks[0]).toMatchObject({
    id: "T001",
    complexity: "standard",
    complexityReason: "Touches parser and CLI contract",
  });
  expect(tasks[1]).toMatchObject({
    id: "T002",
    complexity: "mechanical",
    complexityReason: "Single isolated test file",
  });
});

it("accepts a 500-character reason and rejects a 501-character reason", () => {
  expect(
    parseSpecKitTasks(
      exactTaskDocumentV2Fixture({ complexityReason: "x".repeat(500) }),
    )[0],
  ).toMatchObject({ complexityReason: "x".repeat(500) });
  expect(() =>
    parseSpecKitTasks(
      exactTaskDocumentV2Fixture({ complexityReason: "x".repeat(501) }),
    ),
  ).toThrow(TaskRecordError);
});

it.each([
  [
    "missing assessment fields",
    (document: string) =>
      document.replace(
        ' | complexity=standard | why="Touches parser and CLI contract"',
        "",
      ),
  ],
  [
    "missing complexity",
    (document: string) => document.replace(" | complexity=standard", ""),
  ],
  [
    "missing why",
    (document: string) =>
      document.replace(' | why="Touches parser and CLI contract"', ""),
  ],
  [
    "unknown complexity tier",
    (document: string) =>
      document.replace("complexity=standard", "complexity=expert"),
  ],
  [
    "empty reason",
    (document: string) =>
      document.replace(
        'why="Touches parser and CLI contract"',
        'why="   "',
      ),
  ],
  [
    "malformed reason JSON",
    (document: string) =>
      document.replace(
        'why="Touches parser and CLI contract"',
        'why="unterminated',
      ),
  ],
  [
    "metadata schema is not v2",
    (document: string) =>
      document.replace(
        '"schema":"harness/task-metadata/v2"',
        '"schema":"harness/task-metadata/v1"',
      ),
  ],
  [
    "metadata record lacks the assessment",
    (document: string) =>
      document.replace(
        ',"complexityReason":"Touches parser and CLI contract"',
        "",
      ),
  ],
  [
    "metadata complexity disagrees",
    (document: string) =>
      document.replace('"complexity":"standard"', '"complexity":"mechanical"'),
  ],
  [
    "metadata reason disagrees",
    (document: string) =>
      document.replace(
        '"complexityReason":"Touches parser and CLI contract"',
        '"complexityReason":"Different reason"',
      ),
  ],
  [
    "non-canonical metadata JSON",
    (document: string) =>
      document.replace(
        '{"schema":"harness/task-metadata/v2"',
        '{ "schema":"harness/task-metadata/v2"',
      ),
  ],
] as const)("rejects v2 task contract: %s", (_name, mutate) => {
  expect(() => parseSpecKitTasks(mutate(exactTaskDocumentV2Fixture()))).toThrow(
    TaskRecordError,
  );
});

it("rejects a v1 document carrying v2 assessment fields", () => {
  expect(() =>
    parseSpecKitTasks(
      exactTaskDocumentFixture().replace(
        " | deps=[]",
        ' | complexity=standard | why="x" | deps=[]',
      ),
    ),
  ).toThrow(TaskRecordError);
});

it("keeps the v1 semantic hash stable and changes it for v2 assessments", () => {
  const v1Hash = semanticHash(parseSpecKitTasks(exactTaskDocumentFixture()));
  expect(v1Hash).toBe(
    "sha256:7efcd01f7f701c649f7fcea0df01af474c20f941fa710d243c2edf2d32197bca",
  );
  expect(
    semanticHash(parseSpecKitTasks(exactTaskDocumentV2Fixture())),
  ).not.toBe(v1Hash);
});

it("seals a v2 task graph only from v2 task records", async () => {
  const project = await planningProjectFixture();
  try {
    const specText = await readFile(join(project.root, artifactPaths.spec), "utf8");
    const tasksText = exactTaskDocumentV2Fixture();
    const graph = await sealTaskGraph({
      root: project.root,
      paths: artifactPaths,
      tasksText,
      specText,
    });
    expect(graph.schema).toBe("harness/task-graph/v2");
    expect(graph.tasks[0]).toMatchObject({
      complexity: "standard",
      complexityReason: "Touches parser and CLI contract",
    });
    expect(graph.tasksSemanticHash).toBe(
      semanticHash(parseSpecKitTasks(tasksText)),
    );
    await expect(
      sealTaskGraph({
        root: project.root,
        paths: artifactPaths,
        tasksText,
        specText,
        taskRecords: parseSpecKitTasks(exactTaskDocumentFixture()),
      }),
    ).rejects.toThrow(/task records differ/);
  } finally {
    await project.cleanup();
  }
});

it("seals only references declared uniquely in spec.md", async () => {
  const project = await planningProjectFixture();
  try {
    const tasksText = exactTaskDocumentFixture();
    const specText = await readFile(join(project.root, artifactPaths.spec), "utf8");
    const graph = await sealTaskGraph({
      root: project.root,
      paths: artifactPaths,
      tasksText,
      specText,
    });
    expect(graph.tasks).toHaveLength(2);
    await expect(
      sealTaskGraph({
        root: project.root,
        paths: artifactPaths,
        tasksText,
        specText: specText.replace("- FR-001:", "- FR-999:"),
      }),
    ).rejects.toThrow(/unknown acceptance reference FR-001/);
  } finally {
    await project.cleanup();
  }
});
