import { expect, it } from "vitest";
import { createBlackBoxHarness } from "../support/black-box-harness.js";
import { diamondTaskGraph } from "../support/factories.js";

it("takes a diamond feature to one PR through the public composition root", async () => {
  const system = await createBlackBoxHarness({ graph: diamondTaskGraph() });
  const result = await system.runToQuiescence();
  expect(result.taskStates).toEqual({ T001: "DONE", T002: "DONE", T003: "DONE" });
  expect(result.maxConcurrentImplementation).toBe(2);
  expect(
    result.taskReviews.every(
      (review) => review.worker !== review.implementationWorker,
    ),
  ).toBe(true);
  expect(result.finalReviews).toMatchObject([
    { reviewedCommit: result.pushedCommit, outcome: "approved" },
  ]);
  expect(result.runBranchWasUnchangedDuringCandidateVerification).toBe(true);
  expect(result.pullRequests).toHaveLength(1);
  expect(result.pullRequests[0]?.headCommit).toBe(result.pushedCommit);
});

it("falls back from unavailable Devin to Codex and uses Claude for review", async () => {
  const system = await createBlackBoxHarness({
    graph: diamondTaskGraph(),
    unavailable: ["devin"],
  });
  const result = await system.runToQuiescence();
  expect(Object.values(result.implementations)).toEqual(["codex", "codex", "codex"]);
  expect(result.taskReviews.every((review) => review.worker === "claude")).toBe(true);
});
