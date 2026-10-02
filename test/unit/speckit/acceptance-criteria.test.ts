import { expect, it } from "vitest";
import { acceptanceCriteriaForTask } from "../../../src/speckit/acceptance-criteria.js";

it("selects the task's acceptance text in reference order", () => {
  const spec = [
    "# Specification",
    "- FR-001: Return a parsed value for valid input.",
    "- FR-002: Reject invalid input with an error.",
    "- SC-001: The parser tests pass.",
  ].join("\n");

  expect(acceptanceCriteriaForTask(spec, ["SC-001", "FR-001"])).toEqual([
    "SC-001: The parser tests pass.",
    "FR-001: Return a parsed value for valid input.",
  ]);
});

it("keeps wrapped acceptance text with its requirement", () => {
  const spec = [
    "- FR-001: Return a parsed value",
    "  for valid input.",
    "- FR-002: Reject invalid input.",
  ].join("\n");

  expect(acceptanceCriteriaForTask(spec, ["FR-001"])).toEqual([
    "FR-001: Return a parsed value for valid input.",
  ]);
});
