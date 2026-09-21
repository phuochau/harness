import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import {
  validateTaskGraph,
  type TaskGraphDocument,
} from "../contracts/task-graph.js";
import { canonicalJson } from "../shared/canonical-json.js";
import type { ArtifactPaths } from "./artifacts.js";
import { semanticHash } from "./semantic-hash.js";
import {
  parseSpecKitTasks,
  type CanonicalTaskRecord,
} from "./task-records.js";

export interface SealTaskGraphInput {
  readonly root: string;
  readonly paths: ArtifactPaths;
  readonly tasksText: string;
  readonly specText: string;
  readonly taskRecords?: readonly CanonicalTaskRecord[];
}

export class TaskGraphSealError extends Error {}

function acceptanceDefinitions(specText: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const normalized = specText.replace(/\r\n/g, "\n").normalize("NFC");
  for (const match of normalized.matchAll(/^\s*[-*]\s+((?:FR|SC)-[0-9]{3}):/gm)) {
    const reference = match[1]!;
    counts.set(reference, (counts.get(reference) ?? 0) + 1);
  }
  return counts;
}

function confined(root: string, path: string): string {
  const target = resolve(root, path);
  const prefix = `${resolve(root)}${sep}`;
  if (!target.startsWith(prefix)) {
    throw new TaskGraphSealError(`artifact path escapes project root: ${path}`);
  }
  return target;
}

export async function sealTaskGraph(
  input: SealTaskGraphInput,
): Promise<TaskGraphDocument> {
  const parsed = parseSpecKitTasks(input.tasksText);
  if (
    input.taskRecords !== undefined &&
    canonicalJson(input.taskRecords) !== canonicalJson(parsed)
  ) {
    throw new TaskGraphSealError("provided task records differ from tasks.md");
  }
  const definitions = acceptanceDefinitions(input.specText);
  for (const [reference, count] of definitions) {
    if (count !== 1) {
      throw new TaskGraphSealError(`acceptance reference ${reference} is not unique in spec.md`);
    }
  }
  for (const task of parsed) {
    for (const reference of task.acceptanceRefs) {
      if (definitions.get(reference) !== 1) {
        throw new TaskGraphSealError(`unknown acceptance reference ${reference}`);
      }
    }
  }
  const graph = validateTaskGraph({
    schema: "harness/task-graph/v1",
    tasksSemanticHash: semanticHash(parsed),
    tasks: structuredClone(parsed),
  });
  const target = confined(input.root, input.paths.graph);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(graph)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  return graph;
}

