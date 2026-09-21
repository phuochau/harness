import fc from "fast-check";
import { expect, it } from "vitest";
import { reduceEvent } from "../../../src/core/reducer.js";
import { initialRunState } from "../../../src/core/state.js";
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
