import type { ProfileFamily } from "../contracts/profiles.js";
import type { TaskComplexity } from "../contracts/task-graph.js";
import {
  complexityTierOrder,
  type ComplexityRunner,
} from "../contracts/workflow.js";
import type { ProfileCapabilitySnapshot } from "../state/resolved-run-config.js";

/** @deprecated Runtime adapters retain this alias until the Pi runtime migration. */
export type WorkerKind = ProfileFamily;

export interface RouteCandidate {
  readonly profileId: string;
  readonly family: ProfileFamily;
  readonly available: boolean;
}

export interface WorkerProfile extends RouteCandidate {
  /** @deprecated Use family for policy decisions. */
  readonly kind: WorkerKind;
  readonly authenticated: boolean;
  readonly available: boolean;
  readonly capabilities: ReadonlySet<string>;
  readonly concurrencyLimit: number;
  readonly active: number;
}

export interface WorkerSelection {
  readonly preference: readonly string[];
  readonly profiles: Readonly<Record<string, WorkerProfile>>;
  readonly requirements: ReadonlySet<string>;
  readonly unavailable: ReadonlySet<string>;
}

export class PolicyBlocker extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function selectProfile(
  preference: readonly string[],
  candidates: Readonly<Record<string, RouteCandidate>>,
  excludeFamily?: ProfileFamily,
): RouteCandidate {
  const selected = preference
    .map((profileId) => candidates[profileId])
    .find(
      (candidate) =>
        candidate !== undefined &&
        candidate.available &&
        candidate.family !== excludeFamily,
    );
  if (!selected) {
    throw new PolicyBlocker("NO_ELIGIBLE_PROFILE", "no eligible profile");
  }
  return selected;
}

export function satisfies(
  profile: WorkerProfile,
  requirements: ReadonlySet<string>,
): boolean {
  return [...requirements].every((requirement) =>
    profile.capabilities.has(requirement),
  );
}

export function eligibleWorkers(input: WorkerSelection): WorkerProfile[] {
  return input.preference
    .map((profileId) => input.profiles[profileId])
    .filter((profile): profile is WorkerProfile => Boolean(profile))
    .filter((profile) => profile.authenticated && profile.available)
    .filter((profile) => profile.active < profile.concurrencyLimit)
    .filter((profile) => !input.unavailable.has(profile.profileId))
    .filter((profile) => satisfies(profile, input.requirements));
}

export function selectWorker(input: WorkerSelection): WorkerProfile {
  const selected = eligibleWorkers(input)[0];
  if (!selected) {
    throw new PolicyBlocker("NO_ELIGIBLE_PROFILE", "no eligible profile");
  }
  return selected;
}

export type InitialComplexityRoute =
  | {
      readonly profileId: string;
      readonly actualTier: TaskComplexity;
      readonly candidates: readonly string[];
    }
  | { readonly blockReason: string };

export function selectInitialComplexityRoute(input: {
  readonly complexity: TaskComplexity;
  readonly runner: ComplexityRunner;
  readonly capabilities: ProfileCapabilitySnapshot;
}): InitialComplexityRoute {
  const tiers = complexityTierOrder.slice(
    complexityTierOrder.indexOf(input.complexity),
  );
  const candidates = tiers.flatMap((tier) => input.runner.by_complexity[tier]);
  for (const tier of tiers) {
    const selected = input.runner.by_complexity[tier].find(
      (profileId) => input.capabilities[profileId]?.available === true,
    );
    if (selected !== undefined) {
      return { profileId: selected, actualTier: tier, candidates };
    }
  }
  return { blockReason: "no_available_profile" };
}
