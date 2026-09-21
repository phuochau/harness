import { expect, it } from "vitest";
import type { EffectIntent } from "../../../src/actions/types.js";
import type { JsonValue } from "../../../src/contracts/common.js";
import { createWorkflowLifecycle } from "../../../src/core/workflow-lifecycle.js";

const hash = `sha256:${"a".repeat(64)}` as const;

function intent(
  action: string,
  input: Record<string, JsonValue>,
): EffectIntent<string, JsonValue> {
  return {
    action,
    idempotencyKey: `${action}:fixture:1`,
    recovery: "reconcilable",
    laneKey: "fixture",
    input,
  };
}

it("accepts a typed worker result but does not let the worker skip review/integration", () => {
  const lifecycle = createWorkflowLifecycle();
  const events = lifecycle.observed(
    intent("worker.execute", {
      entityId: "implement:T001",
      jobId: "implement:T001",
      stageId: "implement",
      taskId: "T001",
      worker: "devin",
      attempt: 1,
    }),
    {
      schemaVersion: 1,
      assignmentHash: hash,
      role: "implementation",
      outcome: "completed",
      commit: "worker-head",
      evidence: [],
    },
  );
  expect(events.map((event) => event.eventType)).toEqual([
    "worker.result_observed",
    "job.done",
  ]);
  expect(events[1]?.payload).toEqual({ requiresTaskFinalization: false });
});

it("requires an independently bound review result", () => {
  const lifecycle = createWorkflowLifecycle();
  const reviewIntent = intent("worker.review", {
    entityId: "review:T001",
    jobId: "review:T001",
    stageId: "review",
    taskId: "T001",
    worker: "codex",
    attempt: 1,
  });
  expect(
    lifecycle.observed(reviewIntent, {
      schemaVersion: 1,
      assignmentHash: hash,
      role: "review",
      outcome: "approved",
      reviewedCommit: "worker-head",
      findings: [],
      evidence: [],
    }).map((event) => event.eventType),
  ).toEqual(["worker.result_observed", "review.approved", "job.done"]);
  expect(() => lifecycle.observed(reviewIntent, { outcome: "approved" })).toThrow(
    /result schema/,
  );
});

it("binds task completion to integration and semantic-hash evidence", () => {
  const lifecycle = createWorkflowLifecycle();
  const events = lifecycle.observed(
    intent("git.project-task-status", {
      entityId: "record_task_done:T001",
      jobId: "record_task_done:T001",
      stageId: "record_task_done",
      taskId: "T001",
      tasksSemanticHash: hash,
      attempt: 1,
      worker: "system",
    }),
    {
      taskId: "T001",
      candidateCommit: "candidate",
      targetCommit: "target",
    },
  );
  expect(events).toEqual([
    expect.objectContaining({
      eventType: "task.finalized",
      payload: expect.objectContaining({ taskId: "T001", tasksSemanticHash: hash }),
    }),
    expect.objectContaining({
      eventType: "job.done",
      payload: { requiresTaskFinalization: true },
    }),
  ]);
});

it("fails closed for an unregistered custom action lifecycle", () => {
  const lifecycle = createWorkflowLifecycle();
  expect(() =>
    lifecycle.observed(
      intent("custom.deploy", {
        entityId: "deploy",
        jobId: "deploy",
        stageId: "deploy",
        attempt: 1,
        worker: "system",
      }),
      { ok: true },
    ),
  ).toThrow(/no lifecycle mapper/);
});
