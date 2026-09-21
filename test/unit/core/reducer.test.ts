import fc from "fast-check";
import { expect, it } from "vitest";
import { reduceEvent } from "../../../src/core/reducer.js";
import { initialRunState, type RunState } from "../../../src/core/state.js";
import {
  fixtureCommandProcessedEvent,
  fixtureEventsThroughCommandDecision,
  fixtureEventsThroughWorkerCompletion,
  fixtureEventsWithIntentObservationPauseRetryAndPlanning,
  fixtureSuccessfulTaskEvents,
  nextHarnessEvent,
  replay,
} from "../../support/state-fixtures.js";

it("cannot mark a job done without integrated verification evidence", () => {
  const state = replay(fixtureEventsThroughWorkerCompletion());
  expect(state.jobs["implement:T001"]?.state).toBe("VERIFYING");
  expect(() =>
    reduceEvent(
      state,
      nextHarnessEvent(state, {
        eventType: "job.done",
        entityId: "implement:T001",
        idempotencyKey: "done:implement:T001",
        payload: {},
      }),
    ),
  ).toThrow(/integration evidence/);
});

it("replay is deterministic", () => {
  const events = fixtureSuccessfulTaskEvents();
  expect(replay(events)).toEqual(replay(structuredClone(events)));
});

it("rejects a processed command whose sealed batch is incomplete", () => {
  const state = replay(fixtureEventsThroughCommandDecision({ omitMember: 1 }));
  expect(() => reduceEvent(state, fixtureCommandProcessedEvent(state))).toThrow(
    /decision batch incomplete/,
  );
});

it("replays controller, effect, operator, and planning events", () => {
  const state = replay(
    fixtureEventsWithIntentObservationPauseRetryAndPlanning(),
  );
  expect(state.pendingCommands).toEqual({});
  expect(state.outstandingEffects).toEqual({});
  expect(state.operator.paused).toBe(false);
  expect(state.planning.status).toBe("completed");
});

it("rejects sequence gaps and illegal lifecycle transitions", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 100 }), (sequence) => {
      const state = initialRunState(
        "F023",
        `sha256:${"a".repeat(64)}`,
      );
      const event = nextHarnessEvent(state, {
        sequence,
        eventType: "job.done",
        entityId: "implement:T001",
        idempotencyKey: `illegal:${sequence}`,
        payload: {},
      });
      expect(() => reduceEvent(state, event)).toThrow();
    }),
  );
});

it("moves effect-backed verification and integration through VERIFYING", () => {
  const base = initialRunState("F040", `sha256:${"a".repeat(64)}`);
  const ready = reduceEvent(
    base,
    nextHarnessEvent(base, {
      eventType: "job.ready",
      entityId: "verify:T001",
      idempotencyKey: "ready:verify:T001",
      payload: {},
    }),
  );
  const running = reduceEvent(
    ready,
    nextHarnessEvent(ready, {
      eventType: "attempt.started",
      entityId: "verify:T001",
      idempotencyKey: "attempt:verify:T001:1",
      payload: { attempt: 1, worker: "system" },
    }),
  );
  const verified = reduceEvent(
    running,
    nextHarnessEvent(running, {
      eventType: "verification.passed",
      entityId: "verify:T001",
      idempotencyKey: "verified:T001",
      payload: { commit: "candidate", evidence: [] },
    }),
  );
  expect(verified.jobs["verify:T001"]?.state).toBe("VERIFYING");
});

it("keeps operator cancellation terminal when a worker settles concurrently", () => {
  const base = structuredClone(
    initialRunState("F041", `sha256:${"a".repeat(64)}`),
  ) as RunState;
  base.jobs["implement:T001"] = { state: "RUNNING", attempt: 1, worker: "codex" };
  const cancelled = reduceEvent(base, nextHarnessEvent(base, {
    eventType: "job.blocked",
    entityId: "implement:T001",
    idempotencyKey: "cancelled:T001",
    payload: {
      reason: "cancelled by operator",
      evidence: ["worker.execute:implement:T001:1"],
      suggestedChange: "Retry explicitly.",
    },
  }));
  const observed = reduceEvent(cancelled, nextHarnessEvent(cancelled, {
    eventType: "worker.result_observed",
    entityId: "implement:T001",
    idempotencyKey: "late-result:T001",
    payload: {
      schemaVersion: 1,
      assignmentHash: `sha256:${"b".repeat(64)}`,
      role: "implementation",
      outcome: "completed",
      commit: "c".repeat(40),
      evidence: [],
    },
  }));
  const changesRequested = reduceEvent(observed, nextHarnessEvent(observed, {
    eventType: "review.changes_requested",
    entityId: "implement:T001",
    idempotencyKey: "late-review:T001",
    payload: {
      commit: "c".repeat(40),
      reviewer: "codex",
      findings: ["late review result"],
    },
  }));
  const done = reduceEvent(changesRequested, nextHarnessEvent(changesRequested, {
    eventType: "job.done",
    entityId: "implement:T001",
    idempotencyKey: "late-done:T001",
    payload: {},
  }));
  const failed = reduceEvent(done, nextHarnessEvent(done, {
    eventType: "job.failed",
    entityId: "implement:T001",
    idempotencyKey: "late-failure:T001",
    payload: { reason: "agent exited" },
  }));
  expect(failed.jobs["implement:T001"]).toMatchObject({
    state: "BLOCKED",
    blocker: { reason: "cancelled by operator" },
  });
});
