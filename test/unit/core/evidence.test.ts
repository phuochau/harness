import { expect, it } from "vitest";
import {
  createAssignment,
} from "../../../src/core/assignment.js";
import { validateEvidence } from "../../../src/core/evidence.js";
import {
  approvedReview,
  assignmentFixture,
  fakeEvidenceGit,
  reviewAssignment,
} from "../../support/controller-fixtures.js";
import { completedResult } from "../../support/factories.js";

it("rejects protected-file edits and stale review commits", async () => {
  const assignment = createAssignment(assignmentFixture({ commit: "abc123" }));
  await expect(
    validateEvidence(
      assignment,
      completedResult({ assignmentHash: assignment.assignmentHash }),
      fakeEvidenceGit({ changed: ["spec.md"] }),
    ),
  ).rejects.toThrow(/protected path/);

  const review = reviewAssignment({ commit: "abc123" });
  await expect(
    validateEvidence(
      review,
      approvedReview({
        assignmentHash: review.assignmentHash,
        reviewedCommit: "def456",
      }),
      fakeEvidenceGit(),
    ),
  ).rejects.toThrow(/reviewed commit/);
});

it("requires assignment-bound discipline and test evidence", async () => {
  const assignment = createAssignment(assignmentFixture());
  await expect(
    validateEvidence(
      assignment,
      completedResult({
        assignmentHash: assignment.assignmentHash,
        evidence: [],
      }),
      fakeEvidenceGit(),
    ),
  ).rejects.toThrow(/required evidence/);
});

it("accepts a clean implementation range and detached independent review", async () => {
  const implementation = createAssignment(assignmentFixture());
  await expect(
    validateEvidence(
      implementation,
      completedResult({ assignmentHash: implementation.assignmentHash }),
      fakeEvidenceGit({ changed: ["src/feature.ts"] }),
    ),
  ).resolves.toMatchObject({ accepted: true, headCommit: expect.any(String) });

  const review = reviewAssignment();
  await expect(
    validateEvidence(
      review,
      approvedReview({ assignmentHash: review.assignmentHash }),
      fakeEvidenceGit(),
    ),
  ).resolves.toMatchObject({ accepted: true, reviewedCommit: review.commit });
});

it("rejects assignment hash drift and reviewer worktree mutation", async () => {
  const implementation = createAssignment(assignmentFixture());
  await expect(
    validateEvidence(
      implementation,
      completedResult({ assignmentHash: `sha256:${"f".repeat(64)}` }),
      fakeEvidenceGit(),
    ),
  ).rejects.toThrow(/assignment hash/);

  const review = reviewAssignment();
  await expect(
    validateEvidence(
      review,
      approvedReview({ assignmentHash: review.assignmentHash }),
      fakeEvidenceGit({ status: [" M src/feature.ts"] }),
    ),
  ).rejects.toThrow(/review worktree/);
});
