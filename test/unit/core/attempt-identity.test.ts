import { expect, it } from "vitest";
import { globalAttemptNumber, scopedAttemptKey } from "../../../src/core/attempt-identity.js";
import { initialRunState } from "../../../src/core/state.js";

const revision = `sha256:${"a".repeat(64)}` as const;

it("preserves legacy keys and attempt numbers", () => {
  const state = initialRunState("identity-legacy", revision);
  expect(scopedAttemptKey("worker.execute", "implement:T001", 1, state)).toBe(
    "worker.execute:implement:T001:1",
  );
  expect(globalAttemptNumber("implement:T001", 1, state)).toBe(1);
});

it("gives a new fix generation distinct keys and a monotonic assignment attempt", () => {
  const state = structuredClone(initialRunState("identity-tiered", revision));
  state.implementationLineages.T001 = {
    taskId: "T001",
    fixRound: 1,
    generation: 2,
    originalProfileId: "implementer-codex",
    originalTier: "standard",
    activeProfileId: "implementer-codex",
    activeTier: "standard",
    acceptedReviews: [],
    globalAttemptSeq: 4,
  };
  expect(scopedAttemptKey("worker.execute", "implement:T001", 1, state)).toBe(
    "worker.execute:implement:T001:1:g2",
  );
  expect(globalAttemptNumber("implement:T001", 1, state)).toBe(5);
  expect(scopedAttemptKey("worker.review", "review:T001", 1, state)).toBe(
    "worker.review:review:T001:1:g2",
  );
});
