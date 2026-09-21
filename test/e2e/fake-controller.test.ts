import { expect, it } from "vitest";
import {
  createControllerFixture,
  graphWithIndependentNonParallelTask,
  successfulFakeResults,
} from "../support/controller-fixtures.js";
import { diamondTaskGraph } from "../support/factories.js";

it("runs a diamond through integration, task projection, review, push, and PR", async () => {
  const system = await createControllerFixture({
    graph: diamondTaskGraph(),
    actionResults: successfulFakeResults(),
  });
  await system.runToQuiescence();
  expect(system.state.tasks).toMatchObject({
    T001: { state: "DONE" },
    T002: { state: "DONE" },
    T003: { state: "DONE" },
  });
  expect(system.metrics.maxConcurrentImplementations).toBe(2);
  expect(system.actionKinds()).toEqual(
    expect.arrayContaining([
      "worker.execute",
      "worker.review",
      "command.run",
      "git.integrate",
      "git.project-task-status",
      "git.push",
      "github.pull-request",
    ]),
  );
});

it("never overlaps a non-parallel task with another implementation", async () => {
  const system = await createControllerFixture({
    graph: graphWithIndependentNonParallelTask(),
    actionResults: successfulFakeResults(),
  });
  await system.runToQuiescence();
  expect(system.metrics.overlapsInvolving("T002")).toEqual([]);
});

it.each(["after-intent", "after-effect"] as const)(
  "recovers %s without duplicate execution or observation",
  async (boundary) => {
    const system = await createControllerFixture({
      graph: diamondTaskGraph(),
      actionResults: successfulFakeResults(),
      crashAt: boundary,
    });
    await system.crashAndRestart();
    expect(system.executeCount("worker.execute", "implement:T001:1")).toBe(1);
    expect(system.observationCount("worker.execute", "implement:T001:1")).toBe(
      1,
    );
  },
);
