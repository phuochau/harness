import { expect, it } from "vitest";
import { compileWorkflow, type CompileInput } from "../../../src/config/compile.js";
import type { ControllerCommand } from "../../../src/contracts/controller-command.js";
import type { HarnessEvent } from "../../../src/contracts/events.js";
import type {
  TaskComplexity,
  TaskGraphV2Document,
} from "../../../src/contracts/task-graph.js";
import { reduceEvent } from "../../../src/core/reducer.js";
import { createWorkflowCommandDeriver } from "../../../src/core/workflow-engine.js";
import { initialRunState, type RunState } from "../../../src/core/state.js";
import { validateGraph } from "../../../src/core/task-graph.js";
import type { ProfileCapabilitySnapshot } from "../../../src/state/resolved-run-config.js";
import {
  diamondTaskGraph,
  fixtureCompileInput,
  fixtureGraphContextFor,
} from "../../support/factories.js";
import { nextHarnessEvent } from "../../support/state-fixtures.js";

function accepted(command: ControllerCommand, acceptedAt = "2026-09-21T00:00:00.000Z") {
  return {
    command,
    acceptedAt,
    acceptedSequence: 1,
    stateRevision: 1,
  };
}

function tick(idempotencyKey: string, acceptedAt?: string) {
  return accepted(
    {
      schemaVersion: 1,
      source: "timer",
      kind: "tick",
      idempotencyKey,
      payload: { reason: "schedule" },
    },
    acceptedAt,
  );
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

function tieredCompileInput(): CompileInput {
  const input = structuredClone(fixtureCompileInput());
  const implement = input.workflow.stages.find((stage) => stage.id === "implement")!;
  implement.runner = {
    by_complexity: {
      mechanical: ["implementer-claude"],
      standard: ["implementer-codex"],
      complex: ["implementer-devin"],
    },
  };
  return input;
}

function capabilitySnapshot(
  availability: Readonly<Record<string, boolean>>,
): ProfileCapabilitySnapshot {
  return Object.fromEntries(
    Object.entries(availability).map(([profileId, available]) => [
      profileId,
      {
        available,
        evidence: [
          available
            ? "managed profile resources verified"
            : "authentication not ready",
        ],
      },
    ]),
  );
}

function singleTaskV2Graph(complexity: TaskComplexity): TaskGraphV2Document {
  const base = diamondTaskGraph();
  const task = base.tasks[0]!;
  return {
    schema: "harness/task-graph/v2",
    tasksSemanticHash: base.tasksSemanticHash,
    tasks: [
      { ...task, complexity, complexityReason: `assessment for ${task.id}` },
    ],
  };
}

function stateWithTasksDone(runId: string): RunState {
  const state = structuredClone(initialRunState(runId, revision)) as RunState;
  state.jobs.prepare = { state: "DONE", attempt: 1, worker: "system" };
  state.jobs.tasks = { state: "DONE", attempt: 1, worker: "pi" };
  return state;
}

function workerFor(effects: readonly { input: unknown }[], jobId: string) {
  return effects.find(
    (effect) =>
      typeof effect.input === "object" &&
      effect.input !== null &&
      (effect.input as { jobId?: unknown }).jobId === jobId,
  );
}

function pendingTieredReview(fixRound: number, tier: "standard" | "complex" = "standard") {
  const state = stateWithTasksDone(`F-fix-${fixRound}`);
  state.jobs["implement:T001"] = {
    state: "DONE", attempt: 1, worker: "implementer-codex",
    route: { profileId: "implementer-codex", cause: "initial", tier: "standard", fixRound: 0 },
  };
  state.jobs["review:T001"] = {
    state: "RETRY", attempt: 1, worker: "reviewer-claude", retryReason: "changes_requested",
  };
  state.implementationLineages.T001 = {
    taskId: "T001", fixRound, generation: fixRound + 1,
    originalProfileId: tier === "complex" ? "implementer-devin" : "implementer-codex",
    originalTier: tier, activeProfileId: "implementer-codex", activeTier: "standard",
    pendingReview: {
      commit: `commit-${fixRound}`,
      findings: ["Fix failing parser case"],
      reviewedFixRound: fixRound,
      reviewEventKey: `review-${fixRound}`,
    },
    acceptedReviews: [], globalAttemptSeq: 2 + fixRound * 2,
  };
  return state;
}

it("dispatches one durable fix after accepted review and then starts the new generation", () => {
  const workflow = compileWorkflow(tieredCompileInput());
  const document = singleTaskV2Graph("standard");
  const derive = createWorkflowCommandDeriver({
    workflow, graph: validateGraph(document, fixtureGraphContextFor(document)),
    profileCapabilities: capabilitySnapshot({ "implementer-codex": true, "implementer-devin": true }),
  });
  let state = pendingTieredReview(0);
  const transition = derive(state, tick("tick:fix-dispatch"));
  expect(transition.effects).toEqual([]);
  expect(transition.events.filter((event) => event.eventType === "implementation.fix_dispatched")).toHaveLength(1);
  expect(transition.events).toContainEqual(expect.objectContaining({
    eventType: "implementation.fix_dispatched",
    payload: expect.objectContaining({ fixRound: 1, generation: 2, profileId: "implementer-codex" }),
  }));
  for (const draft of transition.events) {
    state = reduceEvent(state, nextHarnessEvent(state, {
      eventType: draft.eventType as HarnessEvent["eventType"],
      entityId: draft.entityId,
      idempotencyKey: draft.idempotencyKey,
      payload: draft.payload,
    }));
  }
  expect(state.implementationLineages.T001?.fixRound).toBe(1);
  expect(state.implementationLineages.T001?.pendingReview).toBeUndefined();
  const retry = derive(state, tick("tick:fix-attempt"));
  expect(retry.effects.find((effect) => effect.action === "worker.execute")?.idempotencyKey).toBe(
    "worker.execute:implement:T001:1:g2",
  );
  expect(workerFor(retry.effects, "implement:T001")?.input).toMatchObject({ worker: "implementer-codex" });
  expect(retry.events.filter((event) => event.eventType === "implementation.fix_dispatched")).toHaveLength(0);
});

it("escalates round four and blocks after the fifth reviewed round", () => {
  const workflow = compileWorkflow(tieredCompileInput());
  const document = singleTaskV2Graph("standard");
  const derive = createWorkflowCommandDeriver({
    workflow, graph: validateGraph(document, fixtureGraphContextFor(document)),
    profileCapabilities: capabilitySnapshot({ "implementer-codex": true, "implementer-devin": true }),
  });
  const fourth = derive(pendingTieredReview(3), tick("tick:round-four"));
  expect(fourth.events).toContainEqual(expect.objectContaining({
    eventType: "implementation.fix_dispatched",
    payload: expect.objectContaining({ fixRound: 4, profileId: "implementer-devin", cause: "escalation" }),
  }));
  const exhausted = derive(pendingTieredReview(5), tick("tick:exhausted"));
  expect(exhausted.effects).toEqual([]);
  expect(exhausted.events).toContainEqual(expect.objectContaining({
    eventType: "job.blocked", payload: expect.objectContaining({ reason: "fix_rounds_exhausted" }),
  }));
});

it("keeps findings pending and blocks escalation when the original tier is strongest", () => {
  const workflow = compileWorkflow(tieredCompileInput());
  const document = singleTaskV2Graph("complex");
  const derive = createWorkflowCommandDeriver({
    workflow, graph: validateGraph(document, fixtureGraphContextFor(document)),
    profileCapabilities: capabilitySnapshot({ "implementer-devin": true }),
  });
  const state = pendingTieredReview(3, "complex");
  const decision = derive(state, tick("tick:no-escalation"));
  expect(decision.effects).toEqual([]);
  expect(decision.events).toContainEqual(expect.objectContaining({
    eventType: "job.blocked",
    entityId: "review:T001",
    payload: expect.objectContaining({ reason: "no_escalation_profile", evidence: ["Fix failing parser case"] }),
  }));
  expect(decision.events.some((event) => event.eventType === "implementation.fix_dispatched")).toBe(false);
  expect(state.implementationLineages.T001?.pendingReview?.findings).toEqual(["Fix failing parser case"]);
});

it("lets an operator reroute unresolved findings to any declared tier without resetting fixRound", () => {
  const workflow = compileWorkflow(tieredCompileInput());
  const document = singleTaskV2Graph("complex");
  const derive = createWorkflowCommandDeriver({
    workflow, graph: validateGraph(document, fixtureGraphContextFor(document)),
    profileCapabilities: capabilitySnapshot({ "implementer-claude": true, "implementer-devin": true }),
  });
  let state = pendingTieredReview(3, "complex");
  const override = derive(state, accepted({
    schemaVersion: 1,
    source: "operator",
    kind: "operator_intent",
    idempotencyKey: "manual-reroute:T001",
    payload: { operation: "reroute", target: "T001", arguments: { worker: "implementer-claude" } },
  }));
  expect(override.effects).toEqual([]);
  expect(override.events).toContainEqual(expect.objectContaining({
    eventType: "implementation.operator_override",
    payload: expect.objectContaining({ profileId: "implementer-claude", tier: "mechanical", generation: 5 }),
  }));
  for (const draft of override.events) {
    state = reduceEvent(state, nextHarnessEvent(state, {
      eventType: draft.eventType as HarnessEvent["eventType"], entityId: draft.entityId,
      idempotencyKey: draft.idempotencyKey, payload: draft.payload,
    }));
  }
  expect(state.implementationLineages.T001).toMatchObject({ fixRound: 3, generation: 5, activeProfileId: "implementer-claude" });
  expect(state.implementationLineages.T001?.pendingReview).toBeUndefined();
  const next = derive(state, tick("tick:manual-reroute"));
  expect(workerFor(next.effects, "implement:T001")?.input).toMatchObject({
    worker: "implementer-claude", fixRound: 3, fixGeneration: 5, routeCause: "operator_reroute",
  });
});

it("uses distinct effect and assignment identities after a fix generation resets local attempts", () => {
  const workflow = compileWorkflow(tieredCompileInput());
  const document = singleTaskV2Graph("standard");
  const derive = createWorkflowCommandDeriver({
    workflow,
    graph: validateGraph(document, fixtureGraphContextFor(document)),
    profileCapabilities: capabilitySnapshot({ "implementer-codex": true }),
  });
  const state = stateWithTasksDone("F036-identity");
  state.implementationLineages.T001 = {
    taskId: "T001",
    fixRound: 1,
    generation: 2,
    originalProfileId: "implementer-codex",
    originalTier: "standard",
    activeProfileId: "implementer-codex",
    activeTier: "standard",
    acceptedReviews: [],
    globalAttemptSeq: 3,
  };
  state.jobs["implement:T001"] = {
    state: "RETRY",
    attempt: 0,
    worker: "implementer-codex",
    route: { profileId: "implementer-codex", cause: "initial", tier: "standard", fixRound: 0 },
  };
  const decision = derive(state, tick("tick:identity"));
  const effect = decision.effects.find((item) => item.action === "worker.execute");
  expect(effect?.idempotencyKey).toBe("worker.execute:implement:T001:1:g2");
  expect(effect?.input).toMatchObject({ attempt: 4, worker: "implementer-codex" });
  expect(decision.events).toContainEqual(expect.objectContaining({
    eventType: "attempt.started",
    idempotencyKey: "attempt:implement:T001:1:g2",
    payload: { attempt: 1, worker: "implementer-codex" },
  }));
});

it("routes a tiered task to the first available declared candidate and journals route evidence", () => {
  const workflow = compileWorkflow(tieredCompileInput());
  const document = singleTaskV2Graph("standard");
  const graph = validateGraph(document, fixtureGraphContextFor(document));
  const derive = createWorkflowCommandDeriver({
    workflow,
    graph,
    profileCapabilities: capabilitySnapshot({
      "implementer-claude": true,
      "implementer-codex": true,
      "implementer-devin": true,
    }),
  });
  const decision = derive(stateWithTasksDone("F036"), tick("tick:route"));
  expect(workerFor(decision.effects, "implement:T001")?.input).toMatchObject({
    worker: "implementer-codex",
  });
  const routed = decision.events.find(
    (event) =>
      event.eventType === "worker.routed" && event.entityId === "implement:T001",
  );
  expect(routed?.payload).toEqual({
    worker: "implementer-codex",
    reason: "initial complexity route",
    taskId: "T001",
    complexity: "standard",
    complexityReason: "assessment for T001",
    candidates: ["implementer-codex", "implementer-devin"],
    tier: "standard",
    fixRound: 0,
    cause: "initial",
    workflowRevision: workflow.revision,
    tasksSemanticHash: graph.graph.tasksSemanticHash,
  });
});

it("falls back only upward to a stronger declared tier when the first candidate is unavailable", () => {
  const workflow = compileWorkflow(tieredCompileInput());
  const document = singleTaskV2Graph("standard");
  const derive = createWorkflowCommandDeriver({
    workflow,
    graph: validateGraph(document, fixtureGraphContextFor(document)),
    profileCapabilities: capabilitySnapshot({
      "implementer-claude": true,
      "implementer-codex": false,
      "implementer-devin": true,
    }),
  });
  const decision = derive(stateWithTasksDone("F037"), tick("tick:fallback"));
  expect(workerFor(decision.effects, "implement:T001")?.input).toMatchObject({
    worker: "implementer-devin",
  });
  const routed = decision.events.find(
    (event) =>
      event.eventType === "worker.routed" && event.entityId === "implement:T001",
  );
  expect(routed?.payload).toMatchObject({
    worker: "implementer-devin",
    complexity: "standard",
    tier: "complex",
    cause: "initial",
    candidates: ["implementer-codex", "implementer-devin"],
  });
});

it("blocks a tiered task with per-candidate diagnostics when no declared profile is available", () => {
  const derive = createWorkflowCommandDeriver({
    workflow: compileWorkflow(tieredCompileInput()),
    graph: (() => {
      const document = singleTaskV2Graph("complex");
      return validateGraph(document, fixtureGraphContextFor(document));
    })(),
    profileCapabilities: capabilitySnapshot({
      "implementer-claude": false,
      "implementer-codex": false,
      "implementer-devin": false,
    }),
  });
  const decision = derive(stateWithTasksDone("F038"), tick("tick:block"));
  expect(decision.effects).toHaveLength(0);
  const blocked = decision.events.find(
    (event) =>
      event.eventType === "job.blocked" && event.entityId === "implement:T001",
  );
  expect(blocked?.payload).toMatchObject({ reason: "no_available_profile" });
  const evidence = (blocked?.payload as { evidence: string[] }).evidence;
  expect(evidence.join("\n")).toContain("implementer-devin");
  expect(evidence.join("\n")).toContain("authentication not ready");
  expect(decision.events).not.toContainEqual(
    expect.objectContaining({
      eventType: "attempt.started",
      entityId: "implement:T001",
    }),
  );
});

it("never downgrades a complex task to a weaker tier when no candidate is available", () => {
  const derive = createWorkflowCommandDeriver({
    workflow: compileWorkflow(tieredCompileInput()),
    graph: (() => {
      const document = singleTaskV2Graph("complex");
      return validateGraph(document, fixtureGraphContextFor(document));
    })(),
    profileCapabilities: capabilitySnapshot({
      "implementer-claude": true,
      "implementer-codex": true,
      "implementer-devin": false,
    }),
  });
  const decision = derive(stateWithTasksDone("F039"), tick("tick:ceiling"));
  expect(decision.effects).toHaveLength(0);
  expect(decision.events).toContainEqual(
    expect.objectContaining({
      eventType: "job.blocked",
      entityId: "implement:T001",
      payload: expect.objectContaining({ reason: "no_available_profile" }),
    }),
  );
});

it("rejects a v1 task graph paired with a tiered runner before dispatch", () => {
  const derive = createWorkflowCommandDeriver({
    workflow: compileWorkflow(tieredCompileInput()),
    graph: (() => {
      const document = diamondTaskGraph();
      return validateGraph(document, fixtureGraphContextFor(document));
    })(),
    profileCapabilities: capabilitySnapshot({
      "implementer-claude": true,
      "implementer-codex": true,
      "implementer-devin": true,
    }),
  });
  expect(() =>
    derive(stateWithTasksDone("F040"), tick("tick:migrate")),
  ).toThrow(/harness\/task-metadata\/v2|migrat/i);
});

it("retains the accepted route across replay even when live availability later changes", () => {
  const workflow = compileWorkflow(tieredCompileInput());
  const document = singleTaskV2Graph("standard");
  const graph = validateGraph(document, fixtureGraphContextFor(document));
  const initial = createWorkflowCommandDeriver({
    workflow,
    graph,
    profileCapabilities: capabilitySnapshot({
      "implementer-claude": true,
      "implementer-codex": false,
      "implementer-devin": true,
    }),
  });
  let state = stateWithTasksDone("F041");
  const first = initial(state, tick("tick:dispatch", "2026-09-20T00:00:00.000Z"));
  for (const draft of first.events) {
    state = reduceEvent(
      state,
      nextHarnessEvent(state, {
        eventType: draft.eventType as HarnessEvent["eventType"],
        entityId: draft.entityId,
        idempotencyKey: draft.idempotencyKey,
        payload: draft.payload,
      }),
    );
  }
  state = reduceEvent(
    state,
    nextHarnessEvent(state, {
      eventType: "worker.result_observed",
      entityId: "implement:T001",
      idempotencyKey: "worker-result:implement:T001:1",
      payload: {
        schemaVersion: 1,
        assignmentHash: `sha256:${"b".repeat(64)}`,
        outcome: "failed",
        reason: "Pi process exited with code 1",
        evidence: ["exit 1"],
      },
    }),
  );
  expect(state.jobs["implement:T001"]?.state).toBe("RETRY");

  const recovered = createWorkflowCommandDeriver({
    workflow,
    graph,
    profileCapabilities: capabilitySnapshot({
      "implementer-claude": true,
      "implementer-codex": true,
      "implementer-devin": false,
    }),
  });
  const second = recovered(state, tick("tick:retry", "2026-09-20T00:10:00.000Z"));
  expect(workerFor(second.effects, "implement:T001")?.input).toMatchObject({
    attempt: 2,
    worker: "implementer-devin",
  });
  expect(second.events).toContainEqual(
    expect.objectContaining({
      eventType: "attempt.started",
      entityId: "implement:T001",
      payload: { attempt: 2, worker: "implementer-devin" },
    }),
  );
  expect(
    second.events.filter((event) => event.eventType === "worker.routed"),
  ).toHaveLength(0);
});

it("keeps credentials and prompts out of route evidence", () => {
  const derive = createWorkflowCommandDeriver({
    workflow: compileWorkflow(tieredCompileInput()),
    graph: (() => {
      const document = singleTaskV2Graph("standard");
      return validateGraph(document, fixtureGraphContextFor(document));
    })(),
    profileCapabilities: capabilitySnapshot({
      "implementer-claude": true,
      "implementer-codex": true,
      "implementer-devin": true,
    }),
  });
  const decision = derive(stateWithTasksDone("F042"), tick("tick:secrets"));
  const routed = decision.events.find(
    (event) =>
      event.eventType === "worker.routed" && event.entityId === "implement:T001",
  );
  expect(Object.keys(routed?.payload as object).sort()).toEqual(
    [
      "candidates",
      "cause",
      "complexity",
      "complexityReason",
      "fixRound",
      "reason",
      "taskId",
      "tasksSemanticHash",
      "tier",
      "worker",
      "workflowRevision",
    ].sort(),
  );
  expect(JSON.stringify(routed?.payload)).not.toMatch(
    /api[_-]?key|bearer|password|secret|token|prompt/i,
  );
});
