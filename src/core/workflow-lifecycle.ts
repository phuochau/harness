import type { EffectIntent } from "../actions/types.js";
import type { JsonValue } from "../contracts/common.js";
import type { DecisionEventDraft } from "../contracts/events.js";
import { validateWorkerResult } from "../contracts/worker-result.js";

interface IntentIdentity {
  readonly jobId: string;
  readonly stageId: string;
  readonly taskId?: string;
  readonly worker: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

function record(value: unknown, label: string): Readonly<Record<string, any>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, any>>;
}

function string(value: Readonly<Record<string, any>>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`action output requires ${key}`);
  }
  return result;
}

function identity(intent: EffectIntent<string, JsonValue>): IntentIdentity {
  const input = record(intent.input, "effect input");
  const taskId = input.taskId;
  return {
    jobId: string(input, "jobId"),
    stageId: string(input, "stageId"),
    worker: string(input, "worker"),
    input,
    ...(typeof taskId === "string" && taskId.length > 0 ? { taskId } : {}),
  };
}

function done(
  intent: EffectIntent<string, JsonValue>,
  jobId: string,
  requiresTaskFinalization = false,
): DecisionEventDraft {
  return {
    eventType: "job.done",
    entityId: jobId,
    idempotencyKey: `done:${intent.idempotencyKey}`,
    payload: { requiresTaskFinalization },
  };
}

function blocked(
  intent: EffectIntent<string, JsonValue>,
  jobId: string,
  reason: string,
  evidence: readonly string[],
  suggestedChange: string,
): DecisionEventDraft {
  return {
    eventType: "job.blocked",
    entityId: jobId,
    idempotencyKey: `blocked:${intent.idempotencyKey}`,
    payload: { reason, evidence: [...evidence], suggestedChange },
  };
}

export interface WorkflowLifecycle {
  observed(
    intent: EffectIntent<string, JsonValue>,
    output: unknown,
  ): readonly DecisionEventDraft[];
  failed(
    intent: EffectIntent<string, JsonValue>,
    error: unknown,
  ): readonly DecisionEventDraft[];
}

export function createWorkflowLifecycle(): WorkflowLifecycle {
  return {
    observed(intent, output) {
      const bound = identity(intent);
      if (intent.action === "worker.execute" || intent.action === "worker.review") {
        let result;
        try {
          result = validateWorkerResult(output);
        } catch (error) {
          throw new Error(
            `worker result schema rejected: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const observed: DecisionEventDraft = {
          eventType: "worker.result_observed",
          entityId: bound.jobId,
          idempotencyKey: `worker-result:${intent.idempotencyKey}`,
          payload: result,
        };
        if (result.outcome === "blocked" || result.outcome === "failed") {
          return [observed];
        }
        if (intent.action === "worker.execute") {
          if (result.role !== "implementation" || result.outcome !== "completed") {
            throw new Error("implementation action returned a non-implementation result");
          }
          return [observed, done(intent, bound.jobId)];
        }
        if (result.role !== "review") {
          throw new Error("review action returned a non-review result");
        }
        if (result.outcome === "changes_requested") {
          return [
            observed,
            {
              eventType: "review.changes_requested",
              entityId: bound.jobId,
              idempotencyKey: `review-changes:${intent.idempotencyKey}`,
              payload: {
                commit: result.reviewedCommit,
                reviewer: bound.worker,
                findings: result.findings,
              },
            },
          ];
        }
        return [
          observed,
          {
            eventType: "review.approved",
            entityId: bound.jobId,
            idempotencyKey: `review-approved:${intent.idempotencyKey}`,
            payload: {
              commit: result.reviewedCommit,
              reviewer: bound.worker,
            },
          },
          done(intent, bound.jobId),
        ];
      }

      if (intent.action === "command.run") {
        const command = record(output, "command output");
        if (typeof command.exitCode !== "number") {
          throw new Error("command output requires exitCode");
        }
        const commit =
          typeof command.commit === "string"
            ? command.commit
            : typeof bound.input.expectedCommit === "string"
              ? bound.input.expectedCommit
              : undefined;
        if (commit === undefined) {
          throw new Error("verification command requires an immutable commit binding");
        }
        const evidence = [command.stdout, command.stderr].filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        );
        if (command.exitCode !== 0) {
          return [{
            eventType: "verification.failed",
            entityId: bound.jobId,
            idempotencyKey: `verification-failed:${intent.idempotencyKey}`,
            payload: {
              commit,
              evidence: evidence.length > 0 ? evidence : [`exit code ${command.exitCode}`],
            },
          }];
        }
        return [
          {
            eventType: "verification.passed",
            entityId: bound.jobId,
            idempotencyKey: `verification-passed:${intent.idempotencyKey}`,
            payload: { commit, evidence },
          },
          done(intent, bound.jobId),
        ];
      }

      if (intent.action === "git.integrate") {
        const value = record(output, "integration output");
        return [
          {
            eventType: "integration.observed",
            entityId: bound.jobId,
            idempotencyKey: `integration:${intent.idempotencyKey}`,
            payload: {
              candidateCommit: string(value, "candidateCommit"),
              candidateRef: string(value, "candidateRef"),
              expectedRunHead: string(value, "expectedRunHead"),
              patchId: string(value, "patchId"),
            },
          },
          done(intent, bound.jobId),
        ];
      }

      if (intent.action === "git.project-task-status") {
        const value = record(output, "task finalization output");
        const taskId = string(value, "taskId");
        if (bound.taskId !== taskId) throw new Error("task finalization identity mismatch");
        const semanticHash = value.tasksSemanticHash ?? bound.input.tasksSemanticHash;
        if (typeof semanticHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(semanticHash)) {
          throw new Error("task finalization requires tasksSemanticHash");
        }
        return [
          {
            eventType: "task.finalized",
            entityId: bound.jobId,
            idempotencyKey: `task-finalized:${intent.idempotencyKey}`,
            payload: {
              taskId,
              candidateCommit: string(value, "candidateCommit"),
              targetCommit: string(value, "targetCommit"),
              tasksSemanticHash: semanticHash,
            },
          },
          done(intent, bound.jobId, true),
        ];
      }

      if (intent.action === "human.approval") {
        const value = record(output, "approval output");
        return value.approved === true
          ? [done(intent, bound.jobId)]
          : [blocked(intent, bound.jobId, "approval denied", [], "Revise the plan or approve it explicitly.")];
      }

      if (intent.action.startsWith("spec-kit.")) {
        const value = record(output, "planning output");
        const stage = string(value, "stage");
        const correlationId = string(value, "correlationId");
        const hashes = record(value.hashes, "planning hashes");
        const payload = stage === "tasks"
          ? { stage, correlationId, commit: string(value, "commit"), hashes }
          : { stage, correlationId, hashes };
        return [
          {
            eventType: "planning.queued",
            entityId: bound.jobId,
            idempotencyKey: `planning-queued:${intent.idempotencyKey}`,
            payload: {
              stage,
              correlationId,
              sessionFile: string(value, "sessionFile"),
              requestEntryId: string(value, "requestEntryId"),
              command: string(value, "command"),
            },
          },
          {
            eventType: "planning.completed",
            entityId: bound.jobId,
            idempotencyKey: `planning-completed:${intent.idempotencyKey}`,
            payload,
          },
          done(intent, bound.jobId),
        ];
      }

      if (
        intent.action === "git.push" ||
        intent.action === "github.pull-request" ||
        intent.action === "git.verify"
      ) {
        return [done(intent, bound.jobId)];
      }

      throw new Error(`no lifecycle mapper registered for ${intent.action}`);
    },

    failed(intent, error) {
      const bound = identity(intent);
      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof error === "object" &&
        error !== null &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      if (code === "INDETERMINATE_EFFECT") {
        const rawEvidence = (error as { evidence?: unknown }).evidence;
        const evidence = Array.isArray(rawEvidence)
          ? rawEvidence.filter((item): item is string => typeof item === "string")
          : [];
        return [blocked(
          intent,
          bound.jobId,
          message,
          evidence,
          "Inspect external state, then retry recovery or resolve the effect manually.",
        )];
      }
      return [{
        eventType: "job.failed",
        entityId: bound.jobId,
        idempotencyKey: `job-failed:${intent.idempotencyKey}`,
        payload: { reason: message },
      }];
    },
  };
}
