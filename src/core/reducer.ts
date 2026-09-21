import type {
  CommandDecisionBatch,
  DecisionEventDraft,
  HarnessEvent,
} from "../contracts/events.js";
import { validateHarnessEvent } from "../contracts/events.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { sha256 } from "../shared/sha256.js";
import {
  ensureJob,
  startAttempt,
  taskIdForJob,
  transitionJob,
} from "./lifecycle.js";
import type { PendingDecision, RunState } from "./state.js";

export class ReducerError extends Error {}

export function decisionBatchHash(
  batch: Omit<CommandDecisionBatch, "decisionHash">,
): `sha256:${string}` {
  return sha256(canonicalJson(batch));
}

function eventMemberKey(event: {
  eventType: string;
  entityId: string;
  idempotencyKey: string;
}): string {
  return `${event.eventType}\0${event.entityId}\0${event.idempotencyKey}`;
}

function assertValidDecisionDraft(draft: DecisionEventDraft): void {
  if (draft.eventType.startsWith("controller.")) {
    throw new ReducerError("decision batches cannot contain controller events");
  }
  try {
    validateHarnessEvent({
      schemaVersion: 1,
      sequence: 1,
      timestamp: "2026-09-20T00:00:00.000Z",
      runId: "validation",
      entityId: draft.entityId,
      idempotencyKey: draft.idempotencyKey,
      fencingToken: 1,
      prevHash: `sha256:${"0".repeat(64)}`,
      eventHash: `sha256:${"0".repeat(64)}`,
      eventType: draft.eventType,
      payload: draft.payload,
    });
  } catch (error) {
    throw new ReducerError(`invalid decision event draft ${draft.eventType}`, {
      cause: error,
    });
  }
}

function recordDecision(state: RunState, event: HarnessEvent): void {
  if (event.eventType !== "controller.command_decided") return;
  const batch = event.payload;
  const pending = state.pendingCommands[batch.commandKey];
  if (!pending) throw new ReducerError(`decision for unknown command ${batch.commandKey}`);
  if (
    batch.acceptedSequence !== pending.receivedSequence ||
    batch.acceptedAt !== pending.receivedAt ||
    batch.stateRevision !== pending.receivedSequence
  ) {
    throw new ReducerError("decision batch acceptance boundary mismatch");
  }
  const { decisionHash, ...unsigned } = batch;
  if (decisionHash !== decisionBatchHash(unsigned)) {
    throw new ReducerError("decision batch hash mismatch");
  }
  batch.events.forEach(assertValidDecisionDraft);
  state.pendingDecisions[batch.commandKey] = {
    batch,
    observedEvents: [],
    observedEffects: [],
  };
}

function markDecisionMember(state: RunState, event: HarnessEvent): void {
  if (event.eventType.startsWith("controller.")) return;
  for (const [commandKey, decision] of Object.entries(state.pendingDecisions)) {
    const observedEvents = new Set(decision.observedEvents);
    const observedEffects = new Set(decision.observedEffects);
    const key = eventMemberKey(event);
    if (decision.batch.events.some((draft) => eventMemberKey(draft) === key)) {
      observedEvents.add(key);
    }
    if (
      event.eventType === "effect.intent" &&
      decision.batch.effects.some(
        (effect) => effect.idempotencyKey === event.payload.idempotencyKey,
      )
    ) {
      observedEffects.add(event.payload.idempotencyKey);
    }
    state.pendingDecisions[commandKey] = {
      ...decision,
      observedEvents: [...observedEvents].sort(),
      observedEffects: [...observedEffects].sort(),
    };
  }
}

function completePendingCommand(state: RunState, event: HarnessEvent): void {
  if (event.eventType !== "controller.command_processed") return;
  const commandKey = event.payload.commandKey;
  const decision = state.pendingDecisions[commandKey];
  if (!state.pendingCommands[commandKey] || !decision) {
    throw new ReducerError(`processed boundary for unknown command ${commandKey}`);
  }
  const expectedEvents = decision.batch.events.map(eventMemberKey);
  const expectedEffects = decision.batch.effects.map(
    (effect) => effect.idempotencyKey,
  );
  if (
    expectedEvents.some((key) => !decision.observedEvents.includes(key)) ||
    expectedEffects.some((key) => !decision.observedEffects.includes(key))
  ) {
    throw new ReducerError(`decision batch incomplete for ${commandKey}`);
  }
  delete state.pendingCommands[commandKey];
  delete state.pendingDecisions[commandKey];
  state.processedCommands[commandKey] = event.sequence;
}

function observeWorkerResult(state: RunState, event: HarnessEvent): void {
  if (event.eventType !== "worker.result_observed") return;
  const job = ensureJob(state, event.entityId);
  job.result = event.payload;
  if (event.payload.outcome === "blocked") {
    job.state = "BLOCKED";
    job.blocker = event.payload.blocker;
  } else if (event.payload.outcome === "failed") {
    job.state = "FAILED";
    job.failure = event.payload.reason;
  } else {
    if (job.state !== "RUNNING") {
      throw new ReducerError(`worker result for non-running job ${event.entityId}`);
    }
    job.state = "VERIFYING";
  }
}

function applyOperatorIntent(state: RunState, event: HarnessEvent): void {
  if (event.eventType !== "operator.intent") return;
  if (event.payload.operation === "pause") state.operator.paused = true;
  if (event.payload.operation === "resume") state.operator.paused = false;
  state.operator.lastIntent = event.idempotencyKey;
}

function applyPlanningEvent(state: RunState, event: HarnessEvent): void {
  switch (event.eventType) {
    case "planning.queued":
      state.planning = {
        status: "pending",
        correlationId: event.payload.correlationId,
        stage: event.payload.stage,
      };
      return;
    case "planning.agent_settled":
    case "planning.transcript_recovered":
      if (state.planning.correlationId !== event.payload.correlationId) {
        throw new ReducerError("planning correlation mismatch");
      }
      state.planning.status = "settled";
      state.planning.finalTurnIndex = event.payload.finalTurnIndex;
      return;
    case "planning.completed":
      if (state.planning.correlationId !== event.payload.correlationId) {
        throw new ReducerError("planning completion correlation mismatch");
      }
      if (state.planning.stage !== event.payload.stage) {
        throw new ReducerError("planning completion stage mismatch");
      }
      if (event.payload.stage === "tasks" && event.payload.commit.length === 0) {
        throw new ReducerError("task planning requires a seal commit");
      }
      state.planning.status = "completed";
      state.planning.hashes = event.payload.hashes;
      return;
    case "planning.blocked":
      state.planning.status = "blocked";
      return;
    default:
      return;
  }
}

function applyEvent(state: RunState, event: HarnessEvent): void {
  switch (event.eventType) {
    case "run.created":
      if (
        event.runId !== state.runId ||
        event.payload.workflowRevision !== state.workflowRevision
      ) {
        throw new ReducerError("run identity mismatch");
      }
      break;
    case "controller.command_received":
      if (state.processedCommands[event.payload.command.idempotencyKey]) break;
      state.pendingCommands[event.payload.command.idempotencyKey] = {
        command: event.payload.command,
        receivedAt: event.timestamp,
        receivedSequence: event.sequence,
      };
      break;
    case "controller.command_decided":
      recordDecision(state, event);
      break;
    case "controller.command_processed":
      completePendingCommand(state, event);
      break;
    case "job.ready":
      transitionJob(state, event.entityId, ["PENDING", "RETRY"], "READY");
      break;
    case "attempt.started":
      startAttempt(state, event);
      break;
    case "worker.routed":
      ensureJob(state, event.entityId).worker = event.payload.worker;
      break;
    case "worker.result_observed":
      observeWorkerResult(state, event);
      break;
    case "review.approved":
      ensureJob(state, event.entityId).reviewCommit = event.payload.commit;
      break;
    case "review.changes_requested":
      transitionJob(state, event.entityId, "VERIFYING", "RETRY");
      break;
    case "verification.passed":
      ensureJob(state, event.entityId).verificationCommit = event.payload.commit;
      break;
    case "verification.failed":
      transitionJob(state, event.entityId, "VERIFYING", "RETRY");
      break;
    case "integration.observed":
      ensureJob(state, event.entityId).candidateCommit =
        event.payload.candidateCommit;
      state.integrationPipeline = {
        taskId: taskIdForJob(event.entityId) ?? event.entityId,
        status: "verifying_candidate",
      };
      break;
    case "integration.conflicted":
      transitionJob(state, event.entityId, "VERIFYING", "RETRY");
      delete state.integrationPipeline;
      break;
    case "task.finalized":
      state.finalizedTasks[event.payload.taskId] = {
        candidateCommit: event.payload.candidateCommit,
        targetCommit: event.payload.targetCommit,
        tasksSemanticHash: event.payload.tasksSemanticHash,
      };
      delete state.integrationPipeline;
      break;
    case "effect.intent":
      state.outstandingEffects[event.payload.idempotencyKey] = event.payload;
      if (
        event.payload.laneKey.startsWith("integration-pipeline:") &&
        event.payload.input &&
        typeof event.payload.input === "object" &&
        !Array.isArray(event.payload.input) &&
        typeof event.payload.input.taskId === "string"
      ) {
        state.integrationPipeline = {
          taskId: event.payload.input.taskId,
          status: "preparing_candidate",
        };
      }
      break;
    case "effect.observed":
    case "effect.failed":
      delete state.outstandingEffects[event.payload.intentKey];
      break;
    case "operator.intent":
      applyOperatorIntent(state, event);
      break;
    case "planning.queued":
    case "planning.agent_settled":
    case "planning.transcript_recovered":
    case "planning.completed":
    case "planning.blocked":
      applyPlanningEvent(state, event);
      break;
    case "job.done": {
      const taskId = taskIdForJob(event.entityId);
      if (taskId && !state.finalizedTasks[taskId]) {
        throw new ReducerError(`integration evidence missing for ${event.entityId}`);
      }
      transitionJob(state, event.entityId, "VERIFYING", "DONE");
      break;
    }
    case "job.invalidated":
      ensureJob(state, event.entityId).state = "RETRY";
      delete state.integrationPipeline;
      break;
    case "job.blocked": {
      const job = ensureJob(state, event.entityId);
      job.state = "BLOCKED";
      job.blocker = event.payload;
      delete state.integrationPipeline;
      break;
    }
    case "job.failed": {
      const job = ensureJob(state, event.entityId);
      job.state = "FAILED";
      job.failure = event.payload.reason;
      delete state.integrationPipeline;
      break;
    }
  }
}

export function reduceEvent(state: RunState, event: HarnessEvent): RunState {
  if (event.sequence !== state.lastSequence + 1) {
    throw new ReducerError(
      `sequence gap: expected ${state.lastSequence + 1}, received ${event.sequence}`,
    );
  }
  if (event.prevHash !== state.lastEventHash) {
    throw new ReducerError("event hash boundary mismatch");
  }
  const next = structuredClone(state);
  applyEvent(next, event);
  markDecisionMember(next, event);
  next.lastSequence = event.sequence;
  next.lastEventHash = event.eventHash;
  return deepFreeze(next) as RunState;
}
