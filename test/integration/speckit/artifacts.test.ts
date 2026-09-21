import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseSpecKitTasks,
  TaskRecordError,
} from "../../../src/speckit/task-records.js";
import { sealTaskGraph } from "../../../src/speckit/seal-task-graph.js";
import {
  artifactPaths,
  exactTaskDocumentFixture,
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
