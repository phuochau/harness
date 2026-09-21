import type { WorkerKind } from "./routing.js";

export type FailureCategory =
  | "transient_runtime"
  | "worker_unavailable"
  | "authentication"
  | "missing_capability"
  | "task_failure"
  | "verification_failure"
  | "integration_conflict"
  | "policy_violation"
  | "specification_conflict"
  | "indeterminate_effect";

export interface RetryInput {
  readonly category: FailureCategory;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly maxElapsedMs: number;
  readonly currentWorker: WorkerKind;
  readonly fallbacks: readonly WorkerKind[];
  readonly unavailable: ReadonlySet<WorkerKind>;
}

export type RetryDecision =
  | { readonly action: "retry_same"; readonly worker: WorkerKind; readonly reason: string }
  | { readonly action: "reroute"; readonly worker: WorkerKind; readonly reason: string }
  | { readonly action: "block"; readonly reason: string }
  | { readonly action: "exhausted"; readonly reason: string };

const immediateBlockers = new Set<FailureCategory>([
  "authentication",
  "missing_capability",
  "policy_violation",
  "specification_conflict",
  "indeterminate_effect",
]);

export function nextRetry(input: RetryInput): RetryDecision {
  if (immediateBlockers.has(input.category)) {
    return { action: "block", reason: input.category };
  }
  if (
    input.attempt >= input.maxAttempts ||
    input.nowMs - input.startedAtMs >= input.maxElapsedMs
  ) {
    return { action: "exhausted", reason: "retry budget exhausted" };
  }
  if (input.category === "worker_unavailable") {
    const next = input.fallbacks.find(
      (worker) =>
        worker !== input.currentWorker && !input.unavailable.has(worker),
    );
    return next
      ? { action: "reroute", worker: next, reason: input.category }
      : { action: "block", reason: "no declared fallback is available" };
  }
  return {
    action: "retry_same",
    worker: input.currentWorker,
    reason: input.category,
  };
}
