import { expect, it } from "vitest";
import { quickPlanningPrompt } from "../../src/pi/quick-planning-prompt.js";

const artifactPaths = {
  spec: "specs/F023/spec.md",
  plan: "specs/F023/plan.md",
  tasks: "specs/F023/tasks.md",
  graph: "specs/F023/task-graph.json",
};

function request(kind: "bugfix" | "small-feature", brief: string) {
  return {
    stage: "quick" as const,
    command: "/harness.quick-plan" as const,
    correlationId: "F023-quick-1",
    artifactPaths,
    baseline: { hashes: {} },
    kind,
    brief,
  };
}

it("describes the full one-turn artifact contract and the frozen brief", () => {
  const prompt = quickPlanningPrompt(request("bugfix", "Fix the parser crash on empty input"));
  expect(prompt).toContain("harness.quick-plan");
  expect(prompt).toContain("harness-planning:F023-quick-1");
  expect(prompt).toContain("bugfix");
  expect(prompt).toContain("Fix the parser crash on empty input");
  expect(prompt).toContain(artifactPaths.spec);
  expect(prompt).toContain(artifactPaths.plan);
  expect(prompt).toContain(artifactPaths.tasks);
  expect(prompt).toContain(artifactPaths.graph);
  expect(prompt).toContain("harness-task-metadata:v1");
});

it("requires reproduction and a failing regression test for bugfix plans", () => {
  const prompt = quickPlanningPrompt(request("bugfix", "Fix the crash"));
  expect(prompt).toMatch(/reproduc/i);
  expect(prompt).toMatch(/root cause/i);
  expect(prompt).toMatch(/failing (regression )?test/i);
});

it("requires acceptance criteria, scope, and a focused test for small-feature plans", () => {
  const prompt = quickPlanningPrompt(request("small-feature", "Add a --json flag"));
  expect(prompt).toMatch(/acceptance criteria/i);
  expect(prompt).toMatch(/scope/i);
  expect(prompt).toMatch(/focused test/i);
});

it("demands exactly one non-parallel canonical task with paths and acceptance refs", () => {
  const prompt = quickPlanningPrompt(request("small-feature", "Add a flag"));
  expect(prompt).toMatch(/exactly one task/i);
  expect(prompt).toMatch(/non-parallel|parallelEligible: false/i);
  expect(prompt).toMatch(/acceptance/i);
  expect(prompt).toMatch(/owned path|ownedPaths/i);
});
