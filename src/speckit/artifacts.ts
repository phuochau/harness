import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { TaskGraphDocument } from "../contracts/task-graph.js";
import { validateTaskGraph } from "../contracts/task-graph.js";
import { validateGraph } from "../core/task-graph.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { sha256 } from "../shared/sha256.js";
import { sealTaskGraph } from "./seal-task-graph.js";
import { semanticHash } from "./semantic-hash.js";
import { parseSpecKitTasks } from "./task-records.js";

export type PlanningStage = "specify" | "plan" | "tasks";
export type ArtifactName = "spec" | "plan" | "tasks" | "graph";

export interface ArtifactPaths {
  readonly spec: string;
  readonly plan: string;
  readonly tasks: string;
  readonly graph: string;
}

export interface PlanningArtifactContract {
  readonly stage: PlanningStage;
  readonly paths: ArtifactPaths;
  readonly required: readonly ArtifactName[];
  readonly mustChange: readonly ArtifactName[];
  readonly deriveGraph: boolean;
  readonly validateGraph: boolean;
}

export interface ArtifactBaseline {
  readonly hashes: Readonly<Record<string, string>>;
}

export interface LoadedArtifact {
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
}

export interface AcceptedStageArtifacts {
  readonly files: Readonly<Partial<Record<ArtifactName, LoadedArtifact>>>;
  readonly hashes: Readonly<Record<string, string>>;
  readonly graph?: TaskGraphDocument;
}

export class PlanningArtifactError extends Error {}

export function planningArtifactContract(
  stage: PlanningStage,
  paths: ArtifactPaths,
): PlanningArtifactContract {
  if (stage === "specify") {
    return {
      stage,
      paths,
      required: ["spec"],
      mustChange: ["spec"],
      deriveGraph: false,
      validateGraph: false,
    };
  }
  if (stage === "plan") {
    return {
      stage,
      paths,
      required: ["spec", "plan"],
      mustChange: ["plan"],
      deriveGraph: false,
      validateGraph: false,
    };
  }
  return {
    stage,
    paths,
    required: ["spec", "plan", "tasks"],
    mustChange: ["tasks"],
    deriveGraph: true,
    validateGraph: true,
  };
}

function artifactPath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new PlanningArtifactError(`artifact path escapes project root: ${relativePath}`);
  }
  return target;
}

async function loadArtifacts(
  root: string,
  paths: ArtifactPaths,
  required: readonly ArtifactName[],
): Promise<Partial<Record<ArtifactName, LoadedArtifact>>> {
  const result: Partial<Record<ArtifactName, LoadedArtifact>> = {};
  for (const name of required) {
    const path = paths[name];
    let text: string;
    try {
      text = await readFile(artifactPath(root, path), "utf8");
    } catch (error) {
      throw new PlanningArtifactError(
        `required ${name} artifact is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    result[name] = { path, text, sha256: sha256(text) };
  }
  return result;
}

function specAcceptanceReferences(specText: string): ReadonlySet<string> {
  return new Set(
    [...specText.replace(/\r\n/g, "\n").matchAll(/^\s*[-*]\s+((?:FR|SC)-[0-9]{3}):/gm)].map(
      (match) => match[1]!,
    ),
  );
}

export async function validatePlanningArtifacts(
  projectRoot: string,
  contract: PlanningArtifactContract,
  before: ArtifactBaseline,
): Promise<AcceptedStageArtifacts> {
  const root = await realpath(projectRoot);
  const initial = await loadArtifacts(root, contract.paths, contract.required);
  const tasksText = initial.tasks?.text;
  const taskRecords = tasksText === undefined ? undefined : parseSpecKitTasks(tasksText);
  if (contract.deriveGraph) {
    if (taskRecords === undefined || tasksText === undefined || initial.spec === undefined) {
      throw new PlanningArtifactError("task graph derivation requires spec and tasks");
    }
    await sealTaskGraph({
      root,
      paths: contract.paths,
      taskRecords,
      tasksText,
      specText: initial.spec.text,
    });
  }
  const names = contract.deriveGraph
    ? [...contract.required, "graph" as const]
    : [...contract.required];
  const files = await loadArtifacts(root, contract.paths, names);
  for (const [name, file] of Object.entries(initial)) {
    if (file !== undefined && files[name as ArtifactName]?.sha256 !== file.sha256) {
      throw new PlanningArtifactError(
        `${name} changed while planning artifacts were being validated`,
      );
    }
  }
  const hashes: Record<string, string> = {};
  for (const file of Object.values(files)) {
    if (file !== undefined) hashes[file.path] = file.sha256;
  }
  for (const name of contract.mustChange) {
    const file = files[name];
    if (file === undefined || before.hashes[file.path] === file.sha256) {
      throw new PlanningArtifactError(`${name} did not change in the correlated turn`);
    }
  }
  let graph: TaskGraphDocument | undefined;
  if (contract.validateGraph) {
    if (files.graph === undefined || files.tasks === undefined || files.spec === undefined) {
      throw new PlanningArtifactError("graph validation requires spec, tasks, and graph");
    }
    try {
      const finalTaskRecords = parseSpecKitTasks(files.tasks.text);
      graph = validateTaskGraph(JSON.parse(files.graph.text));
      validateGraph(graph, {
        tasksSemanticHash: semanticHash(finalTaskRecords),
        taskRecords: new Map(finalTaskRecords.map((task) => [task.id, task] as const)),
        acceptanceRefs: specAcceptanceReferences(files.spec.text),
      });
    } catch (error) {
      throw new PlanningArtifactError(
        `derived graph is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return deepFreeze({
    files,
    hashes,
    ...(graph === undefined ? {} : { graph }),
  });
}
