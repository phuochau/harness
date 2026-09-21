import {
  PolicyBlocker,
  eligibleWorkers,
  type WorkerProfile,
  type WorkerSelection,
} from "./routing.js";
import type { ProfileFamily } from "../contracts/profiles.js";

export interface ReviewSelection extends WorkerSelection {
  readonly implementationFamily: ProfileFamily;
}

export function selectReviewer(input: ReviewSelection): WorkerProfile {
  const selected = eligibleWorkers(input).find(
    (profile) => profile.family !== input.implementationFamily,
  );
  if (!selected) {
    throw new PolicyBlocker(
      "NO_INDEPENDENT_REVIEWER",
      "no independent reviewer is eligible",
    );
  }
  return selected;
}
