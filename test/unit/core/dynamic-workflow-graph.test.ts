import { expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import type { AcceptedCommandRecord } from "../../../src/controller/command-source.js";
import { initialRunState } from "../../../src/core/state.js";
import {
  createWorkflowCommandDeriver,
  emptyTaskGraph,
} from "../../../src/core/workflow-engine.js";
import { validateGraph } from "../../../src/core/task-graph.js";
import { diamondTaskGraph, fixtureGraphContextFor } from "../../support/factories.js";

const accepted: AcceptedCommandRecord = {
  command: {
    schemaVersion: 1,
    source: "timer",
    kind: "tick",
    idempotencyKey: "tick:1",
    payload: {},
  },
  acceptedAt: "2026-09-21T00:00:00.000Z",
  acceptedSequence: 1,
  stateRevision: 1,
};

it("materializes foreach jobs from the graph available at decision time", () => {
  const workflow = compileWorkflow({
    environment: {
      schema: "harness/environment/v1",
      commands: {},
      pi_packages: [],
    },
    workflow: {
      schema: "harness/v1",
      name: "dynamic-graph",
      task_model: {
        source: "stages.tasks.outputs.graph",
        complete_when: { stage: "implement" },
      },
      stages: [{
        id: "implement",
        uses: "worker.execute",
        runner: { prefer: ["devin", "codex", "claude"] },
        foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
        gate: "task.dependencies_done",
      }],
    },
  });
  let graph = emptyTaskGraph();
  const derive = createWorkflowCommandDeriver({ workflow, graph: () => graph });
  const state = initialRunState("F023", workflow.revision);
  expect(derive(state, accepted).effects).toHaveLength(0);

  const document = diamondTaskGraph();
  graph = validateGraph(document, fixtureGraphContextFor(document));
  expect(derive(state, accepted).effects.map((effect) =>
    (effect.input as { taskId: string }).taskId
  ).sort()).toEqual(["T001", "T002"]);
});
