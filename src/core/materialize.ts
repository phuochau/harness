import type { CompiledStage, CompiledWorkflow } from "../config/compile.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { jobId } from "./job-id.js";
import type { ValidatedTaskGraph } from "./task-graph.js";

export interface MaterializedJob {
  readonly id: string;
  readonly stageId: string;
  readonly taskId?: string;
  readonly dependsOn: readonly string[];
}

export interface MaterializedRunGraph {
  readonly jobs: Readonly<Record<string, MaterializedJob>>;
  readonly taskProjection: Readonly<Record<string, readonly string[]>>;
}

export class MaterializationError extends Error {}

function resolveJobDependencies(
  stage: CompiledStage,
  key: string | undefined,
  jobs: ReadonlyMap<string, MaterializedJob>,
): string[] {
  const result: string[] = [];
  const seenStages = new Set<string>();
  for (const need of stage.needs ?? []) {
    if (seenStages.has(need.stage)) {
      throw new MaterializationError(
        `ambiguous mixed joins for upstream stage ${need.stage}`,
      );
    }
    seenStages.add(need.stage);
    const upstream = [...jobs.values()].filter(
      (candidate) => candidate.stageId === need.stage,
    );
    if (need.scope === "same-item") {
      if (key === undefined) {
        throw new MaterializationError(
          `same-item join on singleton stage ${stage.id}`,
        );
      }
      const matching = upstream.filter((candidate) => candidate.taskId === key);
      if (matching.length !== 1) {
        throw new MaterializationError(
          `same-item join ${need.stage} -> ${stage.id}:${key} has no identical key`,
        );
      }
      result.push(matching[0]!.id);
      continue;
    }
    if (upstream.length === 0) {
      throw new MaterializationError(
        `empty barrier ${need.stage} -> ${stage.id}`,
      );
    }
    result.push(...upstream.map((candidate) => candidate.id));
  }
  return result;
}

export function materializeJobs(
  workflow: CompiledWorkflow,
  graph: ValidatedTaskGraph,
): MaterializedRunGraph {
  const jobs = new Map<string, MaterializedJob>();
  for (const stage of workflow.stages) {
    const keys: readonly (string | undefined)[] = stage.foreach
      ? graph.order
      : [undefined];
    for (const key of keys) {
      const id = jobId(stage.id, key);
      if (jobs.has(id)) {
        throw new MaterializationError(`duplicate key ${id}`);
      }
      const dependsOn = resolveJobDependencies(stage, key, jobs);
      jobs.set(id, {
        id,
        stageId: stage.id,
        ...(key === undefined ? {} : { taskId: key }),
        dependsOn,
      });
    }
  }
  const taskProjection = Object.fromEntries(
    graph.order.map((taskId) => [
      taskId,
      [...jobs.values()]
        .filter((job) => job.taskId === taskId)
        .map((job) => job.id),
    ]),
  );
  return deepFreeze({ jobs: Object.fromEntries(jobs), taskProjection });
}
