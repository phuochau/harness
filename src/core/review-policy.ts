import {
  PolicyBlocker,
  eligibleWorkers,
  type WorkerKind,
  type WorkerProfile,
  type WorkerSelection,
} from "./routing.js";

export interface ReviewSelection extends WorkerSelection {
  readonly implementationWorker: WorkerKind;
}

export function selectReviewer(input: ReviewSelection): WorkerProfile {
  const selected = eligibleWorkers(input).find(
    (profile) => profile.kind !== input.implementationWorker,
  );
  if (!selected) {
    throw new PolicyBlocker(
      "NO_INDEPENDENT_REVIEWER",
      "no independent reviewer is eligible",
    );
  }
  return selected;
}
