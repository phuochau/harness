import { expect, it } from "vitest";
import { selectReviewer } from "../../../src/core/review-policy.js";
import { nextRetry } from "../../../src/core/retry.js";
import { selectWorker } from "../../../src/core/routing.js";
import {
  reviewFixture,
  routeFixture,
} from "../../support/controller-fixtures.js";

it("uses Codex after Devin fails and Claude for independent review", () => {
  const implementation = selectWorker(
    routeFixture({ unavailable: ["devin"] }),
  );
  expect(implementation.kind).toBe("codex");
  expect(
    selectReviewer(reviewFixture({ implementationWorker: "codex" })).kind,
  ).toBe("claude");
});

it("blocks when no distinct reviewer is eligible", () => {
  expect(() =>
    selectReviewer(
      reviewFixture({
        implementationWorker: "codex",
        unavailable: ["claude", "devin"],
      }),
    ),
  ).toThrow(/independent reviewer/);
});

it("filters workers by capabilities and authentication", () => {
  const selected = selectWorker(
    routeFixture({
      requirements: ["sandbox"],
      unauthenticated: ["devin"],
      capabilities: { codex: ["sandbox"], claude: [] },
    }),
  );
  expect(selected.kind).toBe("codex");
});

it("bounds retries by attempts and elapsed time", () => {
  expect(
    nextRetry({
      category: "transient_runtime",
      attempt: 1,
      maxAttempts: 3,
      startedAtMs: 0,
      nowMs: 100,
      maxElapsedMs: 1_000,
      currentWorker: "devin",
      fallbacks: ["codex", "claude"],
      unavailable: new Set(),
    }),
  ).toMatchObject({ action: "retry_same", worker: "devin" });
  expect(
    nextRetry({
      category: "transient_runtime",
      attempt: 3,
      maxAttempts: 3,
      startedAtMs: 0,
      nowMs: 100,
      maxElapsedMs: 1_000,
      currentWorker: "devin",
      fallbacks: ["codex"],
      unavailable: new Set(),
    }).action,
  ).toBe("exhausted");
});

it.each([
  "authentication",
  "missing_capability",
  "specification_conflict",
  "indeterminate_effect",
  "policy_violation",
] as const)("blocks %s without consuming retry budget", (category) => {
  expect(
    nextRetry({
      category,
      attempt: 1,
      maxAttempts: 3,
      startedAtMs: 0,
      nowMs: 1,
      maxElapsedMs: 1_000,
      currentWorker: "devin",
      fallbacks: ["codex"],
      unavailable: new Set(),
    }),
  ).toMatchObject({ action: "block" });
});

it("reroutes an unavailable worker in declared order", () => {
  expect(
    nextRetry({
      category: "worker_unavailable",
      attempt: 1,
      maxAttempts: 3,
      startedAtMs: 0,
      nowMs: 1,
      maxElapsedMs: 1_000,
      currentWorker: "devin",
      fallbacks: ["codex", "claude"],
      unavailable: new Set(["codex"]),
    }),
  ).toMatchObject({ action: "reroute", worker: "claude" });
});
