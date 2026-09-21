import { expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import { materializeJobs } from "../../../src/core/materialize.js";
import { validateGraph } from "../../../src/core/task-graph.js";
import {
  diamondTaskGraph,
  fixtureCompileInput,
  fixtureGraphContext,
} from "../../support/factories.js";

function validateDiamond() {
  return validateGraph(diamondTaskGraph(), fixtureGraphContext());
}

it("materializes same-item joins and an all barrier", () => {
  const result = materializeJobs(
    compileWorkflow(fixtureCompileInput()),
    validateDiamond(),
  );
  expect(result.jobs["review:T001"]?.dependsOn).toEqual(["implement:T001"]);
  expect(result.jobs["integrate:T003"]?.dependsOn).toEqual(["verify:T003"]);
  expect(result.jobs["record_task_done:T003"]?.dependsOn).toEqual([
    "post_integrate_verify:T003",
  ]);
  expect(result.jobs.final_verify?.dependsOn).toEqual([
    "record_task_done:T001",
    "record_task_done:T002",
    "record_task_done:T003",
  ]);
  expect(result.taskProjection.T001).toContain("implement:T001");
});

it("rejects duplicate dynamic keys", () => {
  const graph = validateDiamond();
  const duplicateProjection = { ...graph, order: ["T001", ...graph.order] };
  expect(() =>
    materializeJobs(compileWorkflow(fixtureCompileInput()), duplicateProjection),
  ).toThrow(/duplicate key/);
});

it("rejects an empty all barrier and same-item join to a singleton", () => {
  const empty = validateGraph(
    {
      schema: "harness/task-graph/v1",
      tasksSemanticHash: `sha256:${"a".repeat(64)}`,
      tasks: [],
    },
    {
      tasksSemanticHash: `sha256:${"a".repeat(64)}`,
      taskRecords: new Map(),
      acceptanceRefs: new Set(),
    },
  );
  expect(() =>
    materializeJobs(compileWorkflow(fixtureCompileInput()), empty),
  ).toThrow(/empty barrier/);

  const input = structuredClone(fixtureCompileInput());
  input.workflow.stages[2]!.needs = [{ stage: "tasks", scope: "same-item" }];
  expect(() => compileWorkflow(input)).toThrow(/same-item/);
});
