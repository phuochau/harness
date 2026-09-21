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

it("turns an explicit retry into a new immutable attempt and fallback route", () => {
  const derive = engine();
  const state = structuredClone(initialRunState("F031", revision)) as RunState;
  state.jobs["implement:T001"] = {
    state: "FAILED",
    attempt: 1,
    worker: "devin",
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
        payload: { attempt: 2, worker: "codex" },
      }),
    ]),
  );
});
