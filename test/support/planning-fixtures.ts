import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import type {
  ArtifactBaseline,
  ArtifactPaths,
} from "../../src/speckit/artifacts.js";

export const artifactPaths: ArtifactPaths = {
  spec: "specs/F023/spec.md",
  plan: "specs/F023/plan.md",
  tasks: "specs/F023/tasks.md",
  graph: "specs/F023/task-graph.json",
};

export interface TaskDocumentOptions {
  readonly checkbox?: " " | "x" | "X";
  readonly metadataOwnedPath?: string;
}

function taskRecords(metadataOwnedPath = "src/parser.ts") {
  return [
    {
      acceptanceRefs: ["FR-001"],
      dependsOn: [],
      description: "Implement parser",
      id: "T001",
      labels: ["US1"],
      ownedPaths: [metadataOwnedPath],
      parallelEligible: true,
      phase: "Setup",
    },
    {
      acceptanceRefs: ["SC-001"],
      dependsOn: ["T001"],
      description: "Verify escaped | description",
      id: "T002",
      labels: [],
      ownedPaths: ["test/parser.test.ts"],
      parallelEligible: false,
      phase: "Verification",
    },
  ];
}

export function exactTaskDocumentFixture(
  options: TaskDocumentOptions = {},
): string {
  const checkbox = options.checkbox ?? " ";
  const visible = [
    "# Feature Tasks",
    "",
    "## Phase 1: Setup",
    `- [${checkbox}] T001 [P] [US1] Implement parser | deps=[] | ac=[\"FR-001\"] | paths=[\"src/parser.ts\"]`,
    "",
    "## Phase 2: Verification",
    `- [${checkbox}] T002 Verify escaped \\| description | deps=[\"T001\"] | ac=[\"SC-001\"] | paths=[\"test/parser.test.ts\"]`,
    "",
  ].join("\n");
  const metadata = {
    schema: "harness/task-metadata/v1",
    tasks: taskRecords(options.metadataOwnedPath),
  };
  return `${visible}<!-- harness-task-metadata:v1\n${canonicalJson(metadata)}\n-->`;
}

export type MalformedTaskKind =
  | "missing_metadata_delimiter"
  | "duplicate_json_key"
  | "unknown_visible_syntax"
  | "metadata_task_order_mismatch"
  | "duplicate_set_member"
  | "non_posix_path";

export function malformedTaskDocumentFixture(kind: MalformedTaskKind): string {
  const valid = exactTaskDocumentFixture();
  switch (kind) {
    case "missing_metadata_delimiter":
      return valid.replace("<!-- harness-task-metadata:v1\n", "");
    case "duplicate_json_key":
      return valid.replace(
        '{"schema":"harness/task-metadata/v1"',
        '{"schema":"harness/task-metadata/v1","schema":"harness/task-metadata/v1"',
      );
    case "unknown_visible_syntax":
      return valid.replace("- [ ] T001", "- [~] T001");
    case "metadata_task_order_mismatch": {
      const records = taskRecords().reverse();
      return valid.replace(
        /\{"schema":"harness\/task-metadata\/v1","tasks":.*\}/,
        canonicalJson({ schema: "harness/task-metadata/v1", tasks: records }),
      );
    }
    case "duplicate_set_member":
      return valid.replace('ac=["FR-001"]', 'ac=["FR-001","FR-001"]');
    case "non_posix_path":
      return valid.replace('paths=["src/parser.ts"]', 'paths=["src\\\\parser.ts"]');
  }
}

export async function planningProjectFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-planning-"));
  const files: Record<string, string> = {
    [artifactPaths.spec]: [
      "# Specification",
      "",
      "- FR-001: Parser behavior",
      "- SC-001: Parser verification",
      "",
    ].join("\n"),
    [artifactPaths.plan]: "# Plan\n\nUse a deterministic parser.\n",
    [artifactPaths.tasks]: exactTaskDocumentFixture(),
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function emptyArtifactBaseline(): ArtifactBaseline {
  return { hashes: {} };
}

export async function presetFixture() {
  const root = resolve("presets/harness-task-graph");
  return {
    root,
    manifest: await readFile(join(root, "preset.yml"), "utf8"),
    command: await readFile(join(root, "commands/speckit.tasks.md"), "utf8"),
  };
}
