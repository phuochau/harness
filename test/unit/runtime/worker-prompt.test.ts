import { expect, it } from "vitest";
import { buildWorkerEntryInstruction } from "../../../src/runtime/workers/prompt.js";
import { contractAssignment } from "../../support/worker-fixtures.js";

it("prevents a non-interactive reviewer from stopping before its result protocol", () => {
  const instruction = buildWorkerEntryInstruction(contractAssignment({
    role: "review",
    workerKind: "codex",
    implementationWorkerKind: "devin",
    worktree: {
      role: "review",
      path: "/tmp/review",
      branch: null,
      commit: "abc123",
      writable: false,
    },
  }));

  expect(instruction).toContain("Do not stop after announcing");
  expect(instruction).toContain("HARNESS_REVIEW_RESULT_V1");
});
