import { expect, it } from "vitest";
import { buildWorkerEntryInstruction, buildWorkerPrompt } from "../../../src/runtime/workers/prompt.js";
import { contractAssignment } from "../../support/worker-fixtures.js";
import { superpowersProfile } from "../../../src/runtime/workers/superpowers-profile.js";

it("puts task intent and acceptance before assignment metadata", () => {
  const assignment = contractAssignment({
    taskObjective: "Implement parser behavior",
    acceptanceCriteria: ["FR-001: The parser returns an error for invalid input."],
  });
  const prompt = buildWorkerPrompt(assignment, superpowersProfile(assignment));

  expect(prompt).toContain("Objective:\nImplement parser behavior");
  expect(prompt).toContain("Acceptance criteria:\n- FR-001: The parser returns an error for invalid input.");
  expect(prompt.indexOf("Objective:")).toBeLessThan(prompt.indexOf("Assignment hash:"));
  expect(prompt.indexOf("Acceptance criteria:")).toBeLessThan(prompt.indexOf("Assignment hash:"));
});

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
