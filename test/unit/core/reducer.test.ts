import fc from "fast-check";
import { expect, it } from "vitest";
import type { JsonValue } from "../../../src/contracts/common.js";
import type { HarnessEvent } from "../../../src/contracts/events.js";
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

it("completes quick planning only with a seal commit", () => {
  const revision = `sha256:${"a".repeat(64)}`;
  const state = initialRunState("F023", revision);
  const queued = reduceEvent(
    state,
    nextHarnessEvent(state, {
      eventType: "planning.queued",
      entityId: "planning:quick",
      idempotencyKey: "planning:queued:quick",
      payload: {
        stage: "quick",
        sessionFile: "session.jsonl",
        correlationId: "corr-quick",
        requestEntryId: "entry-1",
        command: "/harness.quick-plan",
      },
    }),
  );
  expect(queued.planning).toMatchObject({ status: "pending", stage: "quick" });
  expect(() =>
    nextHarnessEvent(queued, {
      eventType: "planning.completed",
      entityId: "planning:quick",
      idempotencyKey: "planning:completed:quick",
      payload: {
        stage: "quick",
        correlationId: "corr-quick",
        hashes: {},
      },
    }),
  ).toThrow();
  const completed = reduceEvent(
    queued,
    nextHarnessEvent(queued, {
      eventType: "planning.completed",
      entityId: "planning:quick",
      idempotencyKey: "planning:completed:quick",
      payload: {
        stage: "quick",
        correlationId: "corr-quick",
        commit: "c".repeat(40),
        hashes: { "specs/f/tasks.md": revision },
      },
    }),
  );
  expect(completed.planning).toMatchObject({ status: "completed", stage: "quick" });
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

it("records the accepted complexity route from extended worker.routed evidence", () => {
  const base = initialRunState("F042", `sha256:${"a".repeat(64)}`);
  const state = reduceEvent(base, nextHarnessEvent(base, {
    eventType: "worker.routed",
    entityId: "implement:T001",
    idempotencyKey: "route:implement:T001:1",
    payload: {
      worker: "implementer-devin",
      reason: "initial complexity route",
      taskId: "T001",
      complexity: "standard",
      complexityReason: "assessment for T001",
      candidates: ["implementer-codex", "implementer-devin"],
      tier: "complex",
      fixRound: 0,
      cause: "initial",
      workflowRevision: `sha256:${"a".repeat(64)}`,
      tasksSemanticHash: `sha256:${"b".repeat(64)}`,
    },
  }));
  expect(state.jobs["implement:T001"]).toMatchObject({
    worker: "implementer-devin",
    route: {
      profileId: "implementer-devin",
      cause: "initial",
      tier: "complex",
      complexity: "standard",
      fixRound: 0,
    },
  });
});

it("keeps legacy worker.routed payloads replayable without route state", () => {
  const base = initialRunState("F043", `sha256:${"a".repeat(64)}`);
  const state = reduceEvent(base, nextHarnessEvent(base, {
    eventType: "worker.routed",
    entityId: "implement:T001",
    idempotencyKey: "route:implement:T001:1",
    payload: { worker: "implementer-codex", reason: "workflow preference" },
  }));
  expect(state.jobs["implement:T001"]?.worker).toBe("implementer-codex");
  expect(state.jobs["implement:T001"]?.route).toBeUndefined();
});

// --- durable implementation fix-round lineage ---

function pushDraft(
  state: RunState,
  draft: {
    entityId: string;
    idempotencyKey: string;
    eventType: HarnessEvent["eventType"];
    payload: JsonValue;
  },
): RunState {
  return reduceEvent(state, nextHarnessEvent(state, draft));
}

function commitFor(round: number): string {
  return `${round}`.padStart(40, "0");
}

function lineageBase(revision = `sha256:${"a".repeat(64)}`): RunState {
  return pushDraft(initialRunState("F050", revision), {
    eventType: "worker.routed",
    entityId: "implement:T001",
    idempotencyKey: "route:implement:T001:1",
    payload: {
      worker: "implementer-standard",
      reason: "initial complexity route",
      taskId: "T001",
      complexity: "standard",
      complexityReason: "assessment",
      candidates: ["implementer-standard", "implementer-strong"],
      tier: "standard",
      fixRound: 0,
      cause: "initial",
      workflowRevision: revision,
      tasksSemanticHash: `sha256:${"b".repeat(64)}`,
    },
  });
}

function runAttempt(state: RunState, jobId: string, worker: string): RunState {
  const job = state.jobs[jobId];
  const attempt = (job?.attempt ?? 0) + 1;
  if (job === undefined || job.state === "PENDING" || job.state === "RETRY") {
    state = pushDraft(state, {
      eventType: "job.ready",
      entityId: jobId,
      idempotencyKey: `ready:${jobId}:${state.lastSequence}`,
      payload: {},
    });
  }
  return pushDraft(state, {
    eventType: "attempt.started",
    entityId: jobId,
    idempotencyKey: `attempt:${jobId}:${state.lastSequence}`,
    payload: { attempt, worker },
  });
}

function requestChanges(state: RunState, commit: string): RunState {
  state = runAttempt(state, "review:T001", "reviewer-codex");
  state = pushDraft(state, {
    eventType: "worker.result_observed",
    entityId: "review:T001",
    idempotencyKey: `result:review:T001:${state.lastSequence}`,
    payload: {
      schemaVersion: 1,
      assignmentHash: `sha256:${"b".repeat(64)}`,
      role: "review",
      outcome: "changes_requested",
      reviewedCommit: commit,
      findings: ["finding"],
      evidence: [],
    },
  });
  return pushDraft(state, {
    eventType: "review.changes_requested",
    entityId: "review:T001",
    idempotencyKey: `review-changes:review:T001:${state.lastSequence}`,
    payload: { commit, reviewer: "reviewer-codex", findings: ["finding"] },
  });
}

function dispatchFix(
  state: RunState,
  overrides: Record<string, unknown> = {},
  idempotencyKey?: string,
): RunState {
  const taskId = typeof overrides.taskId === "string" ? overrides.taskId : "T001";
  const lineage = state.implementationLineages[taskId];
  return pushDraft(state, {
    eventType: "implementation.fix_dispatched",
    entityId: `implement:${taskId}`,
    idempotencyKey:
      idempotencyKey ?? `fix-dispatch:${taskId}:${state.lastSequence}`,
    payload: {
      taskId,
      fixRound: (lineage?.fixRound ?? 0) + 1,
      generation: (lineage?.generation ?? 1) + 1,
      profileId: "implementer-standard",
      tier: "standard",
      cause: "review_fix",
      reviewedCommit: lineage?.pendingReview?.commit ?? "missing",
      ...overrides,
    } as JsonValue,
  });
}

function completeFixRound(state: RunState, round: number): RunState {
  state = requestChanges(state, commitFor(round - 1));
  return round >= 4
    ? dispatchFix(state, {
        profileId: "implementer-strong",
        tier: "complex",
        cause: "escalation",
      })
    : dispatchFix(state);
}

it("creates a durable implementation lineage from the initial tiered route", () => {
  const state = lineageBase();
  expect(state.implementationLineages["T001"]).toMatchObject({
    taskId: "T001",
    fixRound: 0,
    generation: 1,
    originalProfileId: "implementer-standard",
    originalTier: "standard",
    activeProfileId: "implementer-standard",
    activeTier: "standard",
    globalAttemptSeq: 0,
  });
  expect(state.implementationLineages["T001"]?.pendingReview).toBeUndefined();
});

it("records the reviewed commit and findings without consuming a fix round", () => {
  const state = requestChanges(lineageBase(), commitFor(0));
  expect(state.implementationLineages["T001"]).toMatchObject({
    fixRound: 0,
    generation: 1,
    pendingReview: {
      commit: commitFor(0),
      findings: ["finding"],
      reviewedFixRound: 0,
    },
  });
  expect(state.jobs["review:T001"]?.state).toBe("RETRY");
});

it("advances fix round and generation only when the dispatch is accepted", () => {
  let state = requestChanges(lineageBase(), commitFor(0));
  state = dispatchFix(state);
  const lineage = state.implementationLineages["T001"];
  expect(lineage).toMatchObject({
    fixRound: 1,
    generation: 2,
    activeProfileId: "implementer-standard",
    activeTier: "standard",
    originalProfileId: "implementer-standard",
    originalTier: "standard",
  });
  expect(lineage?.pendingReview).toBeUndefined();
  expect(lineage?.acceptedReviews).toMatchObject([
    { commit: commitFor(0), reviewedFixRound: 0 },
  ]);
});

it("rejects a fix dispatch without an accepted review", () => {
  const state = lineageBase();
  expect(() => dispatchFix(state)).toThrow(/pending review/);
});

it("requires the original profile and review_fix cause for rounds 1 through 3", () => {
  let state = requestChanges(lineageBase(), commitFor(0));
  expect(() =>
    dispatchFix(state, { profileId: "implementer-strong", tier: "complex" }),
  ).toThrow(/original profile/);
  expect(() =>
    dispatchFix(state, {
      cause: "escalation",
      profileId: "implementer-strong",
      tier: "complex",
    }),
  ).toThrow(/original profile/);
});

it("requires a strictly stronger tier for escalation rounds 4 and 5", () => {
  let state = lineageBase();
  for (let round = 1; round <= 3; round += 1) {
    state = completeFixRound(state, round);
  }
  state = requestChanges(state, commitFor(3));
  expect(() =>
    dispatchFix(state, {
      cause: "escalation",
      profileId: "implementer-standard",
      tier: "standard",
    }),
  ).toThrow(/stronger tier/);
  state = dispatchFix(state, {
    cause: "escalation",
    profileId: "implementer-strong",
    tier: "complex",
  });
  expect(state.implementationLineages["T001"]).toMatchObject({
    fixRound: 4,
    generation: 5,
    originalProfileId: "implementer-standard",
    originalTier: "standard",
    activeProfileId: "implementer-strong",
    activeTier: "complex",
  });
});

it("retains pending findings after a reviewed round 5 and cannot dispatch round 6", () => {
  let state = lineageBase();
  for (let round = 1; round <= 5; round += 1) {
    state = completeFixRound(state, round);
  }
  state = requestChanges(state, commitFor(5));
  const lineage = state.implementationLineages["T001"];
  expect(lineage).toMatchObject({
    fixRound: 5,
    pendingReview: { commit: commitFor(5), reviewedFixRound: 5 },
  });
  expect(() =>
    nextHarnessEvent(state, {
      eventType: "implementation.fix_dispatched",
      entityId: "implement:T001",
      idempotencyKey: "fix-dispatch:T001:6",
      payload: {
        taskId: "T001",
        fixRound: 6,
        generation: (lineage?.generation ?? 0) + 1,
        profileId: "implementer-strong",
        tier: "complex",
        cause: "escalation",
        reviewedCommit: commitFor(5),
      },
    }),
  ).toThrow();
});

it("ignores a duplicate review observation for the same commit", () => {
  let state = requestChanges(lineageBase(), commitFor(0));
  state = pushDraft(state, {
    eventType: "review.changes_requested",
    entityId: "review:T001",
    idempotencyKey: "review-changes:review:T001:duplicate",
    payload: {
      commit: commitFor(0),
      reviewer: "reviewer-codex",
      findings: ["finding"],
    },
  });
  expect(state.implementationLineages["T001"]).toMatchObject({
    fixRound: 0,
    pendingReview: { commit: commitFor(0), reviewedFixRound: 0 },
  });
  state = dispatchFix(state);
  expect(state.implementationLineages["T001"]?.fixRound).toBe(1);
  state = pushDraft(state, {
    eventType: "review.changes_requested",
    entityId: "review:T001",
    idempotencyKey: "review-changes:review:T001:stale",
    payload: {
      commit: commitFor(0),
      reviewer: "reviewer-codex",
      findings: ["finding"],
    },
  });
  expect(state.implementationLineages["T001"]).toMatchObject({
    fixRound: 1,
  });
  expect(state.implementationLineages["T001"]?.pendingReview).toBeUndefined();
});

it("rejects conflicting findings for a different commit while a review is pending", () => {
  const state = requestChanges(lineageBase(), commitFor(0));
  expect(() =>
    pushDraft(state, {
      eventType: "review.changes_requested",
      entityId: "review:T001",
      idempotencyKey: "review-changes:review:T001:conflict",
      payload: {
        commit: commitFor(9),
        reviewer: "reviewer-codex",
        findings: ["other finding"],
      },
    }),
  ).toThrow(/conflicting review findings/);
});

it("replays an identical fix dispatch without a second round", () => {
  let state = requestChanges(lineageBase(), commitFor(0));
  const payload = {
    taskId: "T001",
    fixRound: 1,
    generation: 2,
    profileId: "implementer-standard",
    tier: "standard",
    cause: "review_fix",
    reviewedCommit: commitFor(0),
  };
  state = dispatchFix(state, payload, "fix-dispatch:T001:1");
  const dispatched = state;
  state = dispatchFix(state, payload, "fix-dispatch:T001:1");
  expect(state.implementationLineages["T001"]).toEqual(
    dispatched.implementationLineages["T001"],
  );
});

it("rejects a re-derived fix dispatch once the review is consumed", () => {
  let state = requestChanges(lineageBase(), commitFor(0));
  state = dispatchFix(state);
  expect(() =>
    dispatchFix(
      state,
      { fixRound: 1, generation: 2, reviewedCommit: commitFor(0) },
      "fix-dispatch:T001:1:re-derived",
    ),
  ).toThrow(/pending review/);
});

it("does not consume fix rounds on infrastructure or verification retries", () => {
  let state = requestChanges(lineageBase(), commitFor(0));
  state = pushDraft(state, {
    eventType: "job.invalidated",
    entityId: "implement:T001",
    idempotencyKey: "invalidate:implement:T001:1",
    payload: { supersededGeneration: 1, reason: "worker process exited" },
  });
  state = runAttempt(state, "implement:T001", "implementer-standard");
  state = runAttempt(state, "verify:T001", "system");
  state = pushDraft(state, {
    eventType: "verification.failed",
    entityId: "verify:T001",
    idempotencyKey: "verification-failed:verify:T001",
    payload: { commit: commitFor(0), evidence: ["exit 1"] },
  });
  const lineage = state.implementationLineages["T001"];
  expect(lineage).toMatchObject({ fixRound: 0, generation: 1 });
  expect(lineage?.pendingReview?.commit).toBe(commitFor(0));
  expect(lineage?.globalAttemptSeq).toBe(3);
});

it("mints global attempt ids while resetting generation-local budgets", () => {
  let state = requestChanges(lineageBase(), commitFor(0));
  state = runAttempt(state, "implement:T001", "implementer-standard");
  expect(state.implementationLineages["T001"]?.globalAttemptSeq).toBe(2);
  state = dispatchFix(state);
  expect(state.jobs["implement:T001"]?.attempt).toBe(0);
  expect(state.jobs["review:T001"]?.attempt).toBe(0);
  state = pushDraft(state, {
    eventType: "job.invalidated",
    entityId: "implement:T001",
    idempotencyKey: "invalidate:implement:T001:g2",
    payload: { supersededGeneration: 1, reason: "changes_requested" },
  });
  state = runAttempt(state, "implement:T001", "implementer-standard");
  expect(state.jobs["implement:T001"]?.attempt).toBe(1);
  expect(state.implementationLineages["T001"]?.globalAttemptSeq).toBe(3);
});

it("updates the active route on operator reroute without resetting the fix round", () => {
  let state = requestChanges(lineageBase(), commitFor(0));
  state = dispatchFix(state);
  state = pushDraft(state, {
    eventType: "worker.routed",
    entityId: "implement:T001",
    idempotencyKey: "route:implement:T001:reroute",
    payload: {
      worker: "implementer-strong",
      reason: "operator reroute",
      taskId: "T001",
      complexity: "standard",
      candidates: ["implementer-standard", "implementer-strong"],
      tier: "complex",
      fixRound: 1,
      cause: "operator_reroute",
    },
  });
  expect(state.implementationLineages["T001"]).toMatchObject({
    fixRound: 1,
    generation: 2,
    originalProfileId: "implementer-standard",
    originalTier: "standard",
    activeProfileId: "implementer-strong",
    activeTier: "complex",
  });
});

it("starts a lineage when an operator reroutes a task blocked before its first route", () => {
  let state = initialRunState("reroute-first", `sha256:${"a".repeat(64)}`);
  state = pushDraft(state, {
    eventType: "worker.routed",
    entityId: "implement:T001",
    idempotencyKey: "route:implement:T001:operator-first",
    payload: {
      worker: "implementer-strong",
      reason: "operator reroute",
      taskId: "T001",
      complexity: "standard",
      candidates: ["implementer-strong"],
      tier: "complex",
      fixRound: 0,
      cause: "operator_reroute",
    },
  });
  expect(state.implementationLineages.T001).toMatchObject({
    fixRound: 0,
    originalProfileId: "implementer-strong",
    originalTier: "complex",
  });
});

it("rejects a conflicting initial route for an established lineage", () => {
  const state = lineageBase();
  expect(() =>
    pushDraft(state, {
      eventType: "worker.routed",
      entityId: "implement:T001",
      idempotencyKey: "route:implement:T001:2",
      payload: {
        worker: "implementer-strong",
        reason: "initial complexity route",
        taskId: "T001",
        tier: "complex",
        fixRound: 0,
        cause: "initial",
      },
    }),
  ).toThrow(/conflicting initial route/);
});

it("keeps legacy review.changes_requested replay free of lineage state", () => {
  const state = requestChanges(
    initialRunState("F051", `sha256:${"a".repeat(64)}`),
    commitFor(0),
  );
  expect(state.jobs["review:T001"]).toMatchObject({
    state: "RETRY",
    retryReason: "changes_requested",
  });
  expect(state.implementationLineages["T001"]).toBeUndefined();
});

it("replays lineage events deterministically", () => {
  const revision = `sha256:${"a".repeat(64)}` as const;
  const cursor = { runId: "F023", lastSequence: 0, lastEventHash: `sha256:${"0".repeat(64)}` };
  const drafts = [
    {
      eventType: "run.created" as const,
      entityId: "run:F023",
      idempotencyKey: "run:create",
      payload: { workflowRevision: revision },
    },
    {
      eventType: "worker.routed" as const,
      entityId: "implement:T001",
      idempotencyKey: "route:implement:T001:1",
      payload: {
        worker: "implementer-standard",
        reason: "initial complexity route",
        taskId: "T001",
        complexity: "standard",
        tier: "standard",
        fixRound: 0,
        cause: "initial",
      },
    },
    {
      eventType: "job.ready" as const,
      entityId: "review:T001",
      idempotencyKey: "ready:review:T001",
      payload: {},
    },
    {
      eventType: "attempt.started" as const,
      entityId: "review:T001",
      idempotencyKey: "attempt:review:T001:1",
      payload: { attempt: 1, worker: "reviewer-codex" },
    },
    {
      eventType: "worker.result_observed" as const,
      entityId: "review:T001",
      idempotencyKey: "result:review:T001:1",
      payload: {
        schemaVersion: 1,
        assignmentHash: `sha256:${"b".repeat(64)}`,
        role: "review",
        outcome: "changes_requested",
        reviewedCommit: commitFor(0),
        findings: ["finding"],
        evidence: [],
      },
    },
    {
      eventType: "review.changes_requested" as const,
      entityId: "review:T001",
      idempotencyKey: "review-changes:review:T001:1",
      payload: {
        commit: commitFor(0),
        reviewer: "reviewer-codex",
        findings: ["finding"],
      },
    },
    {
      eventType: "implementation.fix_dispatched" as const,
      entityId: "implement:T001",
      idempotencyKey: "fix-dispatch:T001:1",
      payload: {
        taskId: "T001",
        fixRound: 1,
        generation: 2,
        profileId: "implementer-standard",
        tier: "standard",
        cause: "review_fix",
        reviewedCommit: commitFor(0),
      },
    },
    {
      eventType: "job.ready" as const,
      entityId: "implement:T001",
      idempotencyKey: "ready:implement:T001:g2",
      payload: {},
    },
    {
      eventType: "attempt.started" as const,
      entityId: "implement:T001",
      idempotencyKey: "attempt:implement:T001:g2:1",
      payload: { attempt: 1, worker: "implementer-standard" },
    },
  ];
  const events = drafts.map((draft) => {
    const event = nextHarnessEvent(cursor, draft);
    cursor.lastSequence = event.sequence;
    cursor.lastEventHash = event.eventHash;
    return event;
  });
  const first = replay(events);
  const second = replay(structuredClone(events));
  expect(first).toEqual(second);
  expect(first.implementationLineages["T001"]).toMatchObject({
    fixRound: 1,
    generation: 2,
    activeProfileId: "implementer-standard",
    globalAttemptSeq: 2,
  });
});
