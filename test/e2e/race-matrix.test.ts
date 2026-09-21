import { expect, it } from "vitest";
import { createAssignment } from "../../src/core/assignment.js";
import { validateEvidence } from "../../src/core/evidence.js";
import { selectReviewer } from "../../src/core/review-policy.js";
import {
  approvedReview,
  controllerQueueFixture,
  fakeEvidenceGit,
  reviewAssignment,
  reviewFixture,
  runConcurrentWakeupRace,
} from "../support/controller-fixtures.js";

it("serializes timer, Herdr, Pi-equivalent, and operator wakeups", async () => {
  const result = await runConcurrentWakeupRace();
  expect(result).toEqual({ maxConcurrentTransactions: 1, launchIntentCount: 1 });
});

it("recovers an accepted operator retry without resubmission", async () => {
  const fixture = await controllerQueueFixture({
    crashAfterEvent: "controller.command_received",
  });
  try {
    const command = fixture.multiDecisionOperatorCommand("operator:retry:T001");
    await expect(fixture.queue.enqueue(command)).rejects.toThrow(/injected crash/);
    await fixture.restartAndRecoverPending();
    expect(fixture.derivationsFor(command.idempotencyKey)).toBe(1);
    expect(fixture.eventsFor("controller.command_received", command.idempotencyKey))
      .toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

it("blocks when no independent reviewer exists", () => {
  expect(() => selectReviewer(reviewFixture({
    implementationWorker: "codex",
    unavailable: ["claude", "devin"],
  }))).toThrow(/independent reviewer/);
});

it("rejects review worktree mutation at the acceptance boundary", async () => {
  const assignment = createAssignment(reviewAssignment());
  await expect(
    validateEvidence(
      assignment,
      approvedReview({ assignmentHash: assignment.assignmentHash }),
      fakeEvidenceGit({ status: [" M src/feature.ts"] }),
    ),
  ).rejects.toThrow(/review worktree/);
});
