import type { EffectIntent } from "../actions/types.js";
import type { JsonValue } from "../contracts/common.js";
import type { DecisionEventDraft } from "../contracts/events.js";
import type {
  AcceptedCommandRecord,
  CommandDeriver,
} from "../controller/command-source.js";
import type { CompiledStage, CompiledWorkflow } from "../config/compile.js";
import { materializeJobs, type MaterializedJob } from "./materialize.js";
import type { RunState } from "./state.js";
import type { ValidatedTaskGraph } from "./task-graph.js";
import type { WorkerKind } from "./routing.js";

export interface WorkflowCommandDeriverOptions {
  readonly workflow: CompiledWorkflow;
  readonly graph: ValidatedTaskGraph | (() => ValidatedTaskGraph);
  readonly maxNewEffects?: number;
}

export function emptyTaskGraph(): ValidatedTaskGraph {
  return Object.freeze({
    graph: {
      schema: "harness/task-graph/v1" as const,
      tasksSemanticHash: `sha256:${"0".repeat(64)}` as const,
      tasks: [],
    },
    byId: new Map(),
    order: [],
    reachability: new Map(),
  });
}

function workerPreference(stage: CompiledStage): readonly WorkerKind[] {
  return typeof stage.runner === "object" ? stage.runner.prefer : [];
}

function implementationWorker(state: RunState, taskId: string): string | undefined {
  return Object.entries(state.jobs).find(
    ([jobId]) => jobId.endsWith(`:${taskId}`) && jobId.startsWith("implement:"),
  )?.[1].worker;
}

function selectWorker(
  state: RunState,
  stage: CompiledStage,
  job: MaterializedJob,
  attempt: number,
): string {
  if (stage.runner === "pi") return "pi";
  const preference = workerPreference(stage);
  if (preference.length === 0) return "system";
  if (
    stage.uses === "worker.review" &&
    job.taskId !== undefined &&
    stage.policies?.require_different_worker_kind === true
  ) {
    const implementation = implementationWorker(state, job.taskId);
    const eligible = preference.filter((worker) => worker !== implementation);
    const reviewer = eligible[(attempt - 1) % eligible.length];
    if (reviewer === undefined) throw new Error(`no independent reviewer for ${job.id}`);
    return reviewer;
  }
  return preference[(attempt - 1) % preference.length]!;
}

function recoveryFor(stage: CompiledStage): EffectIntent["recovery"] {
  if (stage.uses === "command.run") {
    return Array.isArray(stage.action.input.probe)
      ? "reconcilable"
      : "non_retryable";
  }
  if (stage.uses === "worker.execute" || stage.uses === "worker.review") {
    return "non_retryable";
  }
  return "reconcilable";
}

function laneFor(runId: string, stage: CompiledStage, job: MaterializedJob): string {
  if (stage.uses === "git.integrate") return `integration-pipeline:${runId}`;
  if (
    stage.uses === "git.project-task-status" ||
    stage.uses === "git.push" ||
    stage.uses === "github.pull-request"
  ) {
    return `run-mutation:${runId}`;
  }
  if (stage.uses.startsWith("spec-kit.")) return `planning:${runId}`;
  return `job:${job.id}`;
}

function dependenciesDone(state: RunState, job: MaterializedJob): boolean {
  return job.dependsOn.every((id) => state.jobs[id]?.state === "DONE");
}

function taskDependenciesDone(
  state: RunState,
  graph: ValidatedTaskGraph,
  job: MaterializedJob,
  stage: CompiledStage,
): boolean {
  if (stage.gate !== "task.dependencies_done" || job.taskId === undefined) return true;
  return graph.byId
    .get(job.taskId)!
    .dependsOn.every((taskId) => state.finalizedTasks[taskId] !== undefined);
}

function runningImplementation(
  state: RunState,
  jobs: Readonly<Record<string, MaterializedJob>>,
  stages: ReadonlyMap<string, CompiledStage>,
): MaterializedJob | undefined {
  return Object.values(jobs).find(
    (job) =>
      stages.get(job.stageId)?.uses === "worker.execute" &&
      state.jobs[job.id]?.state === "RUNNING",
  );
}

export function createWorkflowCommandDeriver(
  options: WorkflowCommandDeriverOptions,
): CommandDeriver {
  const stages = new Map(options.workflow.stages.map((stage) => [stage.id, stage]));
  const maximum = options.maxNewEffects ?? 32;

  return (state: RunState, accepted: AcceptedCommandRecord) => {
    const graph = typeof options.graph === "function" ? options.graph() : options.graph;
    const firstFanOut = options.workflow.stages.findIndex((stage) => stage.foreach !== undefined);
    const activeWorkflow = graph.order.length === 0 && firstFanOut >= 0
      ? { ...options.workflow, stages: options.workflow.stages.slice(0, firstFanOut) }
      : options.workflow;
    const materialized = materializeJobs(activeWorkflow, graph);
    const prefixEvents: DecisionEventDraft[] = [];
    const forcedRetries = new Set<string>();
    let resuming = false;
    if (
      accepted.command.source === "operator" &&
      accepted.command.kind === "operator_intent" &&
      typeof accepted.command.payload === "object" &&
      accepted.command.payload !== null &&
      !Array.isArray(accepted.command.payload)
    ) {
      const payload = accepted.command.payload as Record<string, JsonValue>;
      const operation = payload.operation;
      if (
        typeof operation === "string" &&
        ["retry", "reroute", "cancel", "pause", "resume"].includes(operation)
      ) {
        const target = typeof payload.target === "string" ? payload.target : "run";
        const argumentsValue =
          typeof payload.arguments === "object" &&
          payload.arguments !== null &&
          !Array.isArray(payload.arguments)
            ? payload.arguments
            : {};
        prefixEvents.push({
          eventType: "operator.intent",
          entityId: `run:${state.runId}`,
          idempotencyKey: `operator:${accepted.command.idempotencyKey}`,
          payload: { operation, target, arguments: argumentsValue },
        });
        if (operation === "pause") return { events: prefixEvents, effects: [] };
        if (operation === "resume") resuming = true;
        if (operation === "cancel") {
          prefixEvents.push({
            eventType: "job.blocked",
            entityId: target,
            idempotencyKey: `cancelled:${accepted.command.idempotencyKey}`,
            payload: {
              reason: "cancelled by operator",
              evidence: [accepted.command.idempotencyKey],
              suggestedChange: "Retry explicitly if the work should continue.",
            },
          });
          return { events: prefixEvents, effects: [] };
        }
        if (operation === "retry" || operation === "reroute") {
          const job = state.jobs[target];
          if (job === undefined || !["FAILED", "BLOCKED", "RETRY"].includes(job.state)) {
            throw new Error(`${operation} requires a failed or blocked job target`);
          }
          if (job.state !== "RETRY") {
            prefixEvents.push({
              eventType: "job.invalidated",
              entityId: target,
              idempotencyKey: `retry:${accepted.command.idempotencyKey}`,
              payload: {
                supersededGeneration: Math.max(1, job.attempt),
                reason: `${operation} requested by operator`,
              },
            });
          }
          forcedRetries.add(target);
        }
      }
    }
    if (state.operator.paused && !resuming) {
      return { events: prefixEvents, effects: [] };
    }
    const ready = Object.values(materialized.jobs).filter((job) => {
      const status = state.jobs[job.id]?.state ?? "PENDING";
      const stage = stages.get(job.stageId)!;
      return (
        (status === "PENDING" || status === "RETRY" || forcedRetries.has(job.id)) &&
        dependenciesDone(state, job) &&
        taskDependenciesDone(state, graph, job, stage)
      );
    });

    const activeImplementation = runningImplementation(
      state,
      materialized.jobs,
      stages,
    );
    const implementationCandidates = ready.filter(
      (job) => stages.get(job.stageId)?.uses === "worker.execute",
    );
    let selected = ready;
    if (implementationCandidates.length > 0) {
      const nonParallel = implementationCandidates.find(
        (job) => job.taskId && !graph.byId.get(job.taskId)?.parallelEligible,
      );
      if (activeImplementation !== undefined) {
        selected = ready.filter(
          (job) => stages.get(job.stageId)?.uses !== "worker.execute",
        );
      } else if (nonParallel !== undefined) {
        selected = [nonParallel];
      }
    }

    const events = [...prefixEvents];
    const effects: EffectIntent<string, JsonValue>[] = [];
    const occupiedLanes = new Set(
      Object.values(state.outstandingEffects).map((effect) => effect.laneKey),
    );
    if (state.integrationPipeline !== undefined) {
      occupiedLanes.add(`integration-pipeline:${state.runId}`);
    }
    for (const job of selected) {
      if (effects.length >= maximum) break;
      const stage = stages.get(job.stageId)!;
      const laneKey = laneFor(state.runId, stage, job);
      if (occupiedLanes.has(laneKey)) continue;
      occupiedLanes.add(laneKey);
      const current = state.jobs[job.id];
      const attempt = (current?.attempt ?? 0) + 1;
      const worker = selectWorker(state, stage, job, attempt);
      if (current === undefined || current.state === "PENDING") {
        events.push({
          eventType: "job.ready",
          entityId: job.id,
          idempotencyKey: `ready:${job.id}:${attempt}`,
          payload: {},
        });
      }
      events.push({
        eventType: "attempt.started",
        entityId: job.id,
        idempotencyKey: `attempt:${job.id}:${attempt}`,
        payload: { attempt, worker },
      });
      if (worker !== "system" && worker !== "pi") {
        events.push({
          eventType: "worker.routed",
          entityId: job.id,
          idempotencyKey: `route:${job.id}:${attempt}`,
          payload: { worker, reason: "workflow preference" },
        });
      }
      effects.push({
        action: stage.action.kind,
        idempotencyKey: `${stage.action.kind}:${job.id}:${attempt}`,
        recovery: recoveryFor(stage),
        laneKey,
        input: {
          ...stage.action.input,
          entityId: job.id,
          jobId: job.id,
          stageId: job.stageId,
          ...(job.taskId === undefined ? {} : { taskId: job.taskId }),
          attempt,
          worker,
        } as JsonValue,
      });
    }
    return { events, effects };
  };
}
