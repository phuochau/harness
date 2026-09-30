import type { EffectIntent } from "../actions/types.js";
import type { JsonValue } from "../contracts/common.js";
import type { DecisionEventDraft } from "../contracts/events.js";
import {
  taskComplexity,
  type TaskComplexity,
  type TaskNodeV2,
} from "../contracts/task-graph.js";
import {
  complexityTierOrder,
  stageProfileIds,
  type ComplexityRunner,
} from "../contracts/workflow.js";
import type {
  AcceptedCommandRecord,
  CommandDeriver,
} from "../controller/command-source.js";
import type { CompiledStage, CompiledWorkflow } from "../config/compile.js";
import type { ProfileCapabilitySnapshot } from "../state/resolved-run-config.js";
import { materializeJobs, type MaterializedJob } from "./materialize.js";
import { selectInitialComplexityRoute, selectNextFixRoute } from "./routing.js";
import type { RunState } from "./state.js";
import type { ValidatedTaskGraph } from "./task-graph.js";
import { globalAttemptNumber, scopedAttemptKey } from "./attempt-identity.js";

export interface WorkflowCommandDeriverOptions {
  readonly workflow: CompiledWorkflow;
  readonly graph: ValidatedTaskGraph | (() => ValidatedTaskGraph);
  readonly maxNewEffects?: number;
  readonly profileCapabilities?: ProfileCapabilitySnapshot;
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

function workerPreference(stage: CompiledStage): readonly string[] {
  return stageProfileIds(stage);
}

function tieredRunner(stage: CompiledStage): ComplexityRunner | undefined {
  const runner = stage.runner;
  if (typeof runner !== "object" || !("by_complexity" in runner)) {
    return undefined;
  }
  return runner;
}

function tieredRouteCandidates(
  runner: ComplexityRunner,
  complexity: TaskComplexity,
): readonly string[] {
  return complexityTierOrder
    .slice(complexityTierOrder.indexOf(complexity))
    .flatMap((tier) => runner.by_complexity[tier]);
}

function implementationWorker(state: RunState, taskId: string): string | undefined {
  return Object.entries(state.jobs).find(
    ([jobId]) => jobId.endsWith(`:${taskId}`) && jobId.startsWith("implement:"),
  )?.[1].worker;
}

function selectWorker(
  state: RunState,
  workflow: CompiledWorkflow,
  stage: CompiledStage,
  job: MaterializedJob,
  attempt: number,
  requested?: string,
): string {
  const preference = workerPreference(stage);
  if (preference.length === 0) return "system";
  if (requested !== undefined && !preference.includes(requested)) {
    throw new Error(`worker ${requested} is not declared for ${job.id}`);
  }
  if (
    stage.uses === "worker.review" &&
    job.taskId !== undefined &&
    stage.policies?.require_different_profile_family === true
  ) {
    const implementation = implementationWorker(state, job.taskId);
    const implementationFamily = implementation === undefined
      ? undefined
      : workflow.profiles.byId[implementation]?.family;
    const eligible = preference.filter((profileId) =>
      implementationFamily === undefined
        ? profileId !== implementation
        : workflow.profiles.byId[profileId]?.family !== implementationFamily,
    );
    if (requested !== undefined && !eligible.includes(requested)) {
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

function cancellableWorkerEffects(
  target: string,
  state: RunState,
): readonly EffectIntent<string, JsonValue>[] {
  return Object.values(state.outstandingEffects).filter((effect) => {
    if (effect.action !== "worker.execute" && effect.action !== "worker.review") return false;
    if (typeof effect.input !== "object" || effect.input === null || Array.isArray(effect.input)) {
      return false;
    }
    const input = effect.input as Record<string, JsonValue>;
    return target === "run" || input.jobId === target || input.taskId === target;
  });
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
    return "reconcilable";
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
          const active = cancellableWorkerEffects(target, state);
          if (active.length === 0) {
            throw new Error("cancel requires a running worker task or run target");
          }
          return {
            events: prefixEvents,
            effects: active.map((original) => {
              const input = original.input as Record<string, JsonValue>;
              return {
                action: "worker.cancel",
                idempotencyKey: `worker.cancel:${original.idempotencyKey}:${accepted.command.idempotencyKey}`,
                recovery: "reconcilable",
                laneKey: `cancellation:${original.laneKey}`,
                input: {
                  entityId: input.jobId,
                  jobId: input.jobId,
                  stageId: input.stageId,
                  worker: input.worker,
                  originalIntent: original,
                } as unknown as JsonValue,
              };
            }),
          };
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
    // A reviewed implementation advances at a separate durable boundary. Do not
    // schedule from the pre-transition state: the next tick sees the accepted
    // generation and its fresh local retry budgets.
    let pendingFixTransition = false;
    for (const lineage of Object.values(state.implementationLineages)) {
      const pending = lineage.pendingReview;
      if (pending === undefined) continue;
      const implementJob = materialized.jobs[`implement:${lineage.taskId}`];
      const reviewJob = Object.values(materialized.jobs).find(
        (job) => job.taskId === lineage.taskId && stages.get(job.stageId)?.uses === "worker.review",
      );
      if (implementJob === undefined || reviewJob === undefined) continue;
      if (state.jobs[reviewJob.id]?.state === "BLOCKED") continue;
      const runner = tieredRunner(stages.get(implementJob.stageId)!);
      if (runner === undefined) continue;
      const route = selectNextFixRoute({
        fixRound: lineage.fixRound,
        originalProfileId: lineage.originalProfileId,
        originalTier: lineage.originalTier,
        runner,
        capabilities: options.profileCapabilities ?? {},
      });
      pendingFixTransition = true;
      if ("blockReason" in route) {
        prefixEvents.push({
          eventType: "job.blocked",
          entityId: reviewJob.id,
          idempotencyKey: `fix-block:${lineage.taskId}:${pending.reviewEventKey}:${route.blockReason}`,
          payload: {
            reason: route.blockReason,
            evidence: [...pending.findings],
            suggestedChange: "Review the findings and explicitly reroute or resolve this task.",
          },
        });
        continue;
      }
      prefixEvents.push({
        eventType: "implementation.fix_dispatched",
        entityId: implementJob.id,
        idempotencyKey: `fix-dispatch:${lineage.taskId}:${pending.reviewEventKey}:${route.nextFixRound}`,
        payload: {
          taskId: lineage.taskId,
          fixRound: route.nextFixRound,
          generation: lineage.generation + 1,
          profileId: route.profileId,
          tier: route.tier,
          cause: route.cause,
          reviewedCommit: pending.commit,
        },
      });
      const path = remediationPath(materialized.jobs, reviewJob.id, implementJob.id);
      if (path.length === 0) throw new Error(`no review remediation path for ${lineage.taskId}`);
      for (const pathId of path) {
        const pathState = state.jobs[pathId];
        if (pathState === undefined || pathState.state === "PENDING") continue;
        prefixEvents.push({
          eventType: "job.invalidated",
          entityId: pathId,
          idempotencyKey: `fix-invalidate:${lineage.taskId}:${pending.reviewEventKey}:${pathId}`,
          payload: {
            supersededGeneration: Math.max(1, pathState.attempt),
            reason: `review findings at ${pending.commit}`,
          },
        });
      }
    }
    if (pendingFixTransition) return { events: prefixEvents, effects: [] };
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
          idempotencyKey: scopedAttemptKey("policy-block", job.id, current.attempt, state),
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
          idempotencyKey: scopedAttemptKey("retry-exhausted", job.id, current.attempt, state),
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
          idempotencyKey: scopedAttemptKey("remediation-exhausted", job.id, current.attempt, state),
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
            idempotencyKey: `${scopedAttemptKey("remediate", job.id, current.attempt, state)}:${pathId}`,
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
            idempotencyKey: scopedAttemptKey("retry-exhausted", job.id, state.jobs[job.id]?.attempt ?? 0, state),
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
      const forced = forcedWorkers.get(job.id);
      const runner = tieredRunner(stage);
      let worker: string;
      let routedPayload: Record<string, JsonValue> | undefined;
      if (runner !== undefined && stage.uses === "worker.execute") {
        const task = job.taskId === undefined
          ? undefined
          : graph.byId.get(job.taskId);
        const assessed = task !== undefined && taskComplexity(task) !== undefined
          ? (task as TaskNodeV2)
          : undefined;
        if (assessed === undefined) {
          throw new Error(
            `stage ${stage.id} declares by_complexity routing but ` +
              `${job.taskId ?? job.id} lacks a v2 complexity assessment ` +
              `(graph schema ${graph.graph.schema}); migrate by resealing ` +
              `tasks.md through the spec-kit tasks stage so it emits ` +
              `harness/task-metadata/v2 records`,
          );
        }
        const tieredCandidates = [...stageProfileIds(stage)];
        if (forced !== undefined) {
          if (!tieredCandidates.includes(forced)) {
            throw new Error(`worker ${forced} is not declared for ${job.id}`);
          }
          worker = forced;
          routedPayload = {
            worker,
            reason: "operator reroute",
            taskId: assessed.id,
            complexity: assessed.complexity,
            complexityReason: assessed.complexityReason.slice(0, 500),
            candidates: tieredCandidates,
            tier: complexityTierOrder.find((tier) =>
              runner.by_complexity[tier].includes(forced))!,
            fixRound: 0,
            cause: "operator_reroute",
            workflowRevision: options.workflow.revision,
            tasksSemanticHash: graph.graph.tasksSemanticHash,
          };
        } else if (current?.route !== undefined) {
          worker = current.route.profileId;
        } else {
          const capabilities = options.profileCapabilities ?? {};
          const route = selectInitialComplexityRoute({
            complexity: assessed.complexity,
            runner,
            capabilities,
          });
          if ("blockReason" in route) {
            events.push({
              eventType: "job.blocked",
              entityId: job.id,
              idempotencyKey: `route-block:${job.id}:${accepted.acceptedSequence}`,
              payload: {
                reason: route.blockReason,
                evidence: tieredRouteCandidates(runner, assessed.complexity)
                  .map((profileId) => {
                    const entry = capabilities[profileId];
                    return entry === undefined
                      ? `${profileId}: no capability probe recorded`
                      : `${profileId}: ${
                        entry.evidence.slice(0, 8).join("; ") || "unavailable"
                      }`;
                  }),
                suggestedChange:
                  "Authenticate or repair a declared tier profile, then retry the tick or reroute the task.",
              },
            });
            continue;
          }
          worker = route.profileId;
          routedPayload = {
            worker,
            reason: "initial complexity route",
            taskId: assessed.id,
            complexity: assessed.complexity,
            complexityReason: assessed.complexityReason.slice(0, 500),
            candidates: [...route.candidates],
            tier: route.actualTier,
            fixRound: 0,
            cause: "initial",
            workflowRevision: options.workflow.revision,
            tasksSemanticHash: graph.graph.tasksSemanticHash,
          };
        }
      } else {
        worker = selectWorker(
          state,
          options.workflow,
          stage,
          job,
          attempt,
          forced,
        );
        if (worker !== "system" && worker !== "pi") {
          routedPayload = {
            worker,
            reason: forced !== undefined
              ? "operator reroute"
              : "workflow preference",
          };
        }
      }
      if (current === undefined || current.state === "PENDING") {
        events.push({
          eventType: "job.ready",
          entityId: job.id,
          idempotencyKey: scopedAttemptKey("ready", job.id, attempt, state),
          payload: {},
        });
      }
      events.push({
        eventType: "attempt.started",
        entityId: job.id,
        idempotencyKey: scopedAttemptKey("attempt", job.id, attempt, state),
        payload: { attempt, worker },
      });
      if (routedPayload !== undefined) {
        events.push({
          eventType: "worker.routed",
          entityId: job.id,
          idempotencyKey: scopedAttemptKey("route", job.id, attempt, state),
          payload: routedPayload,
        });
      }
      effects.push({
        action: stage.action.kind,
        idempotencyKey: scopedAttemptKey(stage.action.kind, job.id, attempt, state),
        recovery: recoveryFor(stage),
        laneKey,
        input: {
          ...stage.action.input,
          entityId: job.id,
          jobId: job.id,
          stageId: job.stageId,
          ...(job.taskId === undefined ? {} : { taskId: job.taskId }),
          attempt: globalAttemptNumber(job.id, attempt, state),
          worker,
        } as JsonValue,
      });
    }
    return { events, effects };
  };
}
