import { expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import type { ControllerCommand } from "../../../src/contracts/controller-command.js";
import { createWorkflowCommandDeriver } from "../../../src/core/workflow-engine.js";
import { initialRunState, type RunState } from "../../../src/core/state.js";
import { validateGraph } from "../../../src/core/task-graph.js";
import {
  diamondTaskGraph,
  fixtureCompileInput,
  fixtureGraphContextFor,
} from "../../support/factories.js";

function accepted(command: ControllerCommand) {
  return {
    command,
    acceptedAt: "2026-09-21T00:00:00.000Z",
    acceptedSequence: 1,
    stateRevision: 1,
  };
}

function engine() {
  const document = diamondTaskGraph();
  return createWorkflowCommandDeriver({
    workflow: compileWorkflow(fixtureCompileInput()),
    graph: validateGraph(document, fixtureGraphContextFor(document)),
  });
}

const revision = `sha256:${"a".repeat(64)}` as const;

it("records pause and resume before making new scheduling decisions", () => {
  const derive = engine();
  const ready = initialRunState("F030", revision);
  const paused = derive(
    ready,
    accepted({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "pause:1",
      payload: { operation: "pause", target: "run", arguments: {} },
    }),
  );
  expect(paused.events).toEqual([
    expect.objectContaining({ eventType: "operator.intent", payload: expect.objectContaining({ operation: "pause" }) }),
  ]);
  expect(paused.effects).toEqual([]);

  const state = structuredClone(ready) as RunState;
  state.operator.paused = true;
  const resumed = derive(
    state,
    accepted({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "resume:1",
      payload: { operation: "resume", target: "run", arguments: {} },
    }),
  );
  expect(resumed.events[0]).toMatchObject({
    eventType: "operator.intent",
    payload: { operation: "resume" },
  });
  expect(resumed.effects.length).toBeGreaterThan(0);
});

it("turns task cancellation into a durable worker cancellation effect", () => {
  const derive = engine();
  const state = structuredClone(initialRunState("F030", revision)) as RunState;
  state.jobs["implement:T001"] = {
    state: "RUNNING",
    attempt: 1,
    worker: "implementer-codex",
  };
  const original = {
    action: "worker.execute",
    idempotencyKey: "worker.execute:implement:T001:1",
    recovery: "non_retryable" as const,
    laneKey: "job:implement:T001",
    input: {
      entityId: "implement:T001",
      jobId: "implement:T001",
      stageId: "implement",
      taskId: "T001",
      attempt: 1,
      worker: "implementer-codex",
    },
  };
  state.outstandingEffects[original.idempotencyKey] = original;

  const decision = derive(
    state,
    accepted({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "cancel:T001:1",
      payload: { operation: "cancel", target: "T001", arguments: {} },
    }),
  );

  expect(decision.events).toEqual([
    expect.objectContaining({
      eventType: "operator.intent",
      payload: expect.objectContaining({ operation: "cancel", target: "T001" }),
    }),
  ]);
  expect(decision.effects).toEqual([
    expect.objectContaining({
      action: "worker.cancel",
      recovery: "reconcilable",
      laneKey: "cancellation:job:implement:T001",
      input: expect.objectContaining({
        jobId: "implement:T001",
        originalIntent: original,
      }),
    }),
  ]);
});

it("turns an explicit retry into a new immutable attempt and fallback route", () => {
  const derive = engine();
  const state = structuredClone(initialRunState("F031", revision)) as RunState;
  state.jobs["implement:T001"] = {
    state: "FAILED",
    attempt: 1,
    worker: "implementer-devin",
    failure: "worker unavailable",
  };
  state.jobs.prepare = { state: "DONE", attempt: 1, worker: "system" };
  state.jobs.tasks = { state: "DONE", attempt: 1, worker: "pi" };

  const decision = derive(
    state,
    accepted({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "retry:T001:1",
      payload: { operation: "retry", target: "implement:T001", arguments: {} },
    }),
  );
  expect(decision.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ eventType: "operator.intent" }),
      expect.objectContaining({ eventType: "job.invalidated", entityId: "implement:T001" }),
      expect.objectContaining({
        eventType: "attempt.started",
        entityId: "implement:T001",
        payload: { attempt: 2, worker: "implementer-codex" },
      }),
    ]),
  );
});

it("remediates review changes by invalidating and rerunning the declared implementation stage", () => {
  const derive = engine();
  const state = structuredClone(initialRunState("F032", revision)) as RunState;
  state.jobs.prepare = { state: "DONE", attempt: 1, worker: "system" };
  state.jobs.tasks = { state: "DONE", attempt: 1, worker: "pi" };
  state.jobs["implement:T001"] = {
    state: "DONE",
    attempt: 1,
    worker: "implementer-devin",
    firstAttemptAt: "2026-09-21T00:00:00.000Z",
  };
  state.jobs["review:T001"] = {
    state: "RETRY",
    attempt: 1,
    worker: "reviewer-codex",
    retryReason: "changes_requested",
    firstAttemptAt: "2026-09-21T00:00:00.000Z",
  };

  const decision = derive(
    state,
    accepted({
      schemaVersion: 1,
      source: "timer",
      kind: "tick",
      idempotencyKey: "after-review:T001:1",
      payload: { reason: "review_result" },
    }),
  );
  expect(decision.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ eventType: "job.invalidated", entityId: "implement:T001" }),
    expect.objectContaining({
      eventType: "attempt.started",
      entityId: "implement:T001",
      payload: { attempt: 2, worker: "implementer-codex" },
    }),
  ]));
  expect(decision.effects).toContainEqual(expect.objectContaining({
    action: "worker.execute",
    input: expect.objectContaining({ taskId: "T001", attempt: 2, worker: "implementer-codex" }),
  }));
  expect(decision.effects).not.toContainEqual(expect.objectContaining({
    action: "worker.review",
    input: expect.objectContaining({ taskId: "T001" }),
  }));
});

it("resolves a task-level reroute target and honors the requested declared worker", () => {
  const derive = engine();
  const state = structuredClone(initialRunState("F033", revision)) as RunState;
  state.jobs.prepare = { state: "DONE", attempt: 1, worker: "system" };
  state.jobs.tasks = { state: "DONE", attempt: 1, worker: "pi" };
  state.jobs["implement:T001"] = {
    state: "BLOCKED",
    attempt: 1,
    worker: "implementer-devin",
    firstAttemptAt: "2026-09-21T00:00:00.000Z",
  };

  const decision = derive(
    state,
    accepted({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "reroute:T001:claude",
      payload: { operation: "reroute", target: "T001", arguments: { worker: "implementer-claude" } },
    }),
  );
  expect(decision.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ eventType: "job.invalidated", entityId: "implement:T001" }),
    expect.objectContaining({
      eventType: "attempt.started",
      entityId: "implement:T001",
      payload: { attempt: 2, worker: "implementer-claude" },
    }),
  ]));
});

it("fails a retrying job when its finite attempt budget is exhausted", () => {
  const derive = engine();
  const state = structuredClone(initialRunState("F034", revision)) as RunState;
  state.jobs.prepare = { state: "DONE", attempt: 1, worker: "system" };
  state.jobs.tasks = { state: "DONE", attempt: 1, worker: "pi" };
  state.jobs["implement:T001"] = {
    state: "RETRY",
    attempt: 3,
    worker: "implementer-claude",
    retryReason: "task_failure",
    firstAttemptAt: "2026-09-21T00:00:00.000Z",
  };

  const decision = derive(
    state,
    accepted({
      schemaVersion: 1,
      source: "timer",
      kind: "tick",
      idempotencyKey: "retry-budget:T001",
      payload: { reason: "retry" },
    }),
  );
  expect(decision.events).toContainEqual(expect.objectContaining({
    eventType: "job.failed",
    entityId: "implement:T001",
    payload: { reason: "retry budget exhausted" },
  }));
  expect(decision.effects).not.toContainEqual(expect.objectContaining({
    input: expect.objectContaining({ taskId: "T001" }),
  }));
});

it("turns a declared remediation block into a durable blocker", () => {
  const input = structuredClone(fixtureCompileInput());
  const finalReview = input.workflow.stages.find((stage) => stage.id === "final_review")!;
  finalReview.on_failure = {
    changes_requested: { block: "final_review_remediation_required" },
  };
  const document = diamondTaskGraph();
  const derive = createWorkflowCommandDeriver({
    workflow: compileWorkflow(input),
    graph: validateGraph(document, fixtureGraphContextFor(document)),
  });
  const state = structuredClone(initialRunState("F035", revision)) as RunState;
  state.jobs.final_review = {
    state: "RETRY",
    attempt: 1,
    worker: "reviewer-codex",
    retryReason: "changes_requested",
    firstAttemptAt: "2026-09-21T00:00:00.000Z",
  };

  const decision = derive(
    state,
    accepted({
      schemaVersion: 1,
      source: "timer",
      kind: "tick",
      idempotencyKey: "final-review-remediation",
      payload: { reason: "review_result" },
    }),
  );
  expect(decision.events).toContainEqual(expect.objectContaining({
    eventType: "job.blocked",
    entityId: "final_review",
    payload: expect.objectContaining({ reason: "final_review_remediation_required" }),
  }));
  expect(decision.effects).not.toContainEqual(expect.objectContaining({
    action: "worker.review",
    input: expect.objectContaining({ jobId: "final_review" }),
  }));
});
