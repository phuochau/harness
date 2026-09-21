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
  requested?: string,
): string {
  if (stage.runner === "pi") return "pi";
  const preference = workerPreference(stage);
  if (preference.length === 0) return "system";
  if (requested !== undefined && !preference.includes(requested as WorkerKind)) {
    throw new Error(`worker ${requested} is not declared for ${job.id}`);
  }
  if (
    stage.uses === "worker.review" &&
    job.taskId !== undefined &&
    stage.policies?.require_different_worker_kind === true
  ) {
    const implementation = implementationWorker(state, job.taskId);
    const eligible = preference.filter((worker) => worker !== implementation);
    if (requested !== undefined && !eligible.includes(requested as WorkerKind)) {
      throw new Error(`worker ${requested} is not an independent reviewer for ${job.id}`);
    }
    const reviewer = requested ?? eligible[(attempt - 1) % eligible.length];
    if (reviewer === undefined) throw new Error(`no independent reviewer for ${job.id}`);
    return reviewer;
  }
  return requested ?? preference[(attempt - 1) % preference.length]!;
}

function retryBudgetAvailable(
  state: RunState,
  stage: CompiledStage,
  job: MaterializedJob,
  now: string,
): boolean {
  const current = state.jobs[job.id];
  if (current === undefined || current.attempt === 0) return true;
  if (stage.retry === undefined || current.attempt >= stage.retry.max_attempts) return false;
  const started = Date.parse(current.firstAttemptAt ?? now);
  const currentTime = Date.parse(now);
  return Number.isFinite(started) && Number.isFinite(currentTime) &&
    currentTime - started < stage.retry.max_elapsed_seconds * 1_000;
}

function taskOperatorTarget(
  target: string,
  state: RunState,
  jobs: Readonly<Record<string, MaterializedJob>>,
  stages: ReadonlyMap<string, CompiledStage>,
  operation: string,
): string | undefined {
  if (state.jobs[target] !== undefined) return target;
  const candidates = Object.values(jobs)
    .filter((job) => job.taskId === target)
    .filter((job) => ["FAILED", "BLOCKED", "RETRY"].includes(state.jobs[job.id]?.state ?? ""))
    .filter((job) => operation !== "reroute" || typeof stages.get(job.stageId)?.runner === "object");
  return candidates.at(-1)?.id;
}

function remediationPath(
  jobs: Readonly<Record<string, MaterializedJob>>,
  sourceId: string,
  targetId: string,
): readonly string[] {
  const visit = (jobId: string, seen: Set<string>): string[] | undefined => {
    if (jobId === targetId) return [jobId];
    if (seen.has(jobId)) return undefined;
    seen.add(jobId);
    for (const dependency of jobs[jobId]?.dependsOn ?? []) {
      const path = visit(dependency, new Set(seen));
      if (path !== undefined) return [...path, jobId];
    }
    return undefined;
  };
  return visit(sourceId, new Set()) ?? [];
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
    const forcedWorkers = new Map<string, string>();
    const suppressed = new Set<string>();
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
          const resolvedTarget = taskOperatorTarget(
            target,
            state,
            materialized.jobs,
            stages,
            operation,
          );
          const job = resolvedTarget === undefined ? undefined : state.jobs[resolvedTarget];
          if (job === undefined || !["FAILED", "BLOCKED", "RETRY"].includes(job.state)) {
            throw new Error(`${operation} requires a failed or blocked job target`);
          }
          if (job.state !== "RETRY") {
            prefixEvents.push({
              eventType: "job.invalidated",
              entityId: resolvedTarget!,
              idempotencyKey: `retry:${accepted.command.idempotencyKey}`,
              payload: {
                supersededGeneration: Math.max(1, job.attempt),
                reason: `${operation} requested by operator`,
              },
            });
          }
          forcedRetries.add(resolvedTarget!);
          if (operation === "reroute") {
            const worker = argumentsValue.worker;
            if (typeof worker !== "string") throw new Error("reroute requires a worker");
            forcedWorkers.set(resolvedTarget!, worker);
          }
        }
      }
    }
    if (state.operator.paused && !resuming) {
      return { events: prefixEvents, effects: [] };
    }
    for (const job of Object.values(materialized.jobs)) {
      const current = state.jobs[job.id];
      if (current?.state !== "RETRY" || current.retryReason === undefined) continue;
      const stage = stages.get(job.stageId)!;
      const policy = current.retryReason === "changes_requested"
        ? stage.on_failure?.changes_requested
        : current.retryReason === "verification_failed"
          ? stage.on_failure?.verification_failed
          : undefined;
      if (policy !== undefined && "block" in policy) {
        prefixEvents.push({
          eventType: "job.blocked",
          entityId: job.id,
          idempotencyKey: `policy-block:${job.id}:${current.attempt}`,
          payload: {
            reason: policy.block,
            evidence: [current.retryReason],
            suggestedChange: "Resolve the remediation explicitly, then retry the job.",
          },
        });
        suppressed.add(job.id);
        continue;
      }
      if (policy === undefined || !("retry_stage" in policy)) continue;
      if (!retryBudgetAvailable(state, stage, job, accepted.acceptedAt)) {
        prefixEvents.push({
          eventType: "job.failed",
          entityId: job.id,
          idempotencyKey: `retry-exhausted:${job.id}:${current.attempt}`,
          payload: { reason: "retry budget exhausted" },
        });
        suppressed.add(job.id);
        continue;
      }
      const targetId = job.taskId === undefined
        ? policy.retry_stage
        : `${policy.retry_stage}:${job.taskId}`;
      const path = remediationPath(materialized.jobs, job.id, targetId);
      if (path.length === 0) throw new Error(`invalid remediation path ${targetId} -> ${job.id}`);
      const targetJob = materialized.jobs[targetId]!;
      const targetStage = stages.get(targetJob.stageId)!;
      if (!retryBudgetAvailable(state, targetStage, targetJob, accepted.acceptedAt)) {
        prefixEvents.push({
          eventType: "job.failed",
          entityId: job.id,
          idempotencyKey: `remediation-exhausted:${job.id}:${current.attempt}`,
          payload: { reason: `remediation stage ${targetId} exhausted its retry budget` },
        });
        suppressed.add(job.id);
        continue;
      }
      for (const pathId of path) {
        if (pathId === job.id) {
          suppressed.add(pathId);
          continue;
        }
        const pathState = state.jobs[pathId];
        if (pathState !== undefined && pathState.state !== "PENDING") {
          prefixEvents.push({
            eventType: "job.invalidated",
            entityId: pathId,
            idempotencyKey: `remediate:${job.id}:${current.attempt}:${pathId}`,
            payload: {
              supersededGeneration: Math.max(1, pathState.attempt),
              reason: `${current.retryReason} at ${job.id}`,
            },
          });
        }
        if (pathId === targetId) forcedRetries.add(pathId);
        else suppressed.add(pathId);
      }
    }
    const budgetFailures = new Set<string>();
    const ready = Object.values(materialized.jobs).filter((job) => {
      const status = state.jobs[job.id]?.state ?? "PENDING";
      const stage = stages.get(job.stageId)!;
      const eligible = (
        !suppressed.has(job.id) &&
        (status === "PENDING" || status === "RETRY" || forcedRetries.has(job.id)) &&
        dependenciesDone(state, job) &&
        taskDependenciesDone(state, graph, job, stage)
      );
      if (
        eligible &&
        (status === "RETRY" || forcedRetries.has(job.id)) &&
        !retryBudgetAvailable(state, stage, job, accepted.acceptedAt)
      ) {
        if (!budgetFailures.has(job.id)) {
          prefixEvents.push({
            eventType: "job.failed",
            entityId: job.id,
            idempotencyKey: `retry-exhausted:${job.id}:${state.jobs[job.id]?.attempt ?? 0}`,
            payload: { reason: "retry budget exhausted" },
          });
          budgetFailures.add(job.id);
        }
        return false;
      }
      return eligible;
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
      const worker = selectWorker(state, stage, job, attempt, forcedWorkers.get(job.id));
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
          payload: {
            worker,
            reason: forcedWorkers.has(job.id) ? "operator reroute" : "workflow preference",
          },
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
