import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import type { WorkflowDocument } from "../../../src/contracts/index.js";
import {
  fixtureEnvironment,
  fixtureResolvedProfiles,
} from "../../support/factories.js";

const defaults = join(process.cwd(), "src", "defaults");

async function compileDefault(path: string) {
  return compileWorkflow({
    workflow: parse(await readFile(path, "utf8")) as WorkflowDocument,
    environment: fixtureEnvironment(),
    profiles: fixtureResolvedProfiles(),
  });
}

const sharedTail = [
  "worker.execute",
  "worker.review",
  "command.run",
  "git.integrate",
  "command.run",
  "git.project-task-status",
  "command.run",
  "worker.review",
  "git.push",
  "github.pull-request",
];

it("keeps the large-feature workflow's plan approval gate", async () => {
  const workflow = await compileDefault(join(defaults, "workflow.yaml"));
  expect(workflow.stages.map((stage) => stage.id)).toEqual([
    "specify",
    "plan",
    "approve_plan",
    "tasks",
    "implement",
    "review",
    "verify",
    "integrate",
    "post_integrate_verify",
    "record_task_done",
    "final_verify",
    "final_review",
    "push",
    "final_pr",
  ]);
  expect(workflow.stages.map((stage) => stage.uses)).toEqual([
    "spec-kit.specify",
    "spec-kit.plan",
    "human.approval",
    "spec-kit.tasks",
    ...sharedTail,
  ]);
});

it.each(["bugfix", "small-feature"] as const)(
  "compiles the %s preset through every downstream gate without a plan approval",
  async (kind) => {
    const workflow = await compileDefault(
      join(defaults, "workflows", `${kind}.yaml`),
    );
    expect(workflow.stages.map((stage) => stage.id)).toEqual([
      "quick_plan",
      "implement",
      "review",
      "verify",
      "integrate",
      "post_integrate_verify",
      "record_task_done",
      "final_verify",
      "final_review",
      "push",
      "final_pr",
    ]);
    expect(workflow.stages.map((stage) => stage.uses)).toEqual([
      "harness.quick-plan",
      ...sharedTail,
    ]);
    const planner = workflow.stages[0]!;
    expect(planner.action.input["kind"]).toBe(kind);
    expect(workflow.taskModel?.source).toBe("stages.quick_plan.outputs.graph");
    expect(
      workflow.stages.every((stage) => stage.uses !== "human.approval"),
    ).toBe(true);
  },
);
