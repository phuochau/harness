export type WorkerKind = "codex" | "devin" | "claude";

export interface WorkerProfile {
  readonly kind: WorkerKind;
  readonly authenticated: boolean;
  readonly available: boolean;
  readonly capabilities: ReadonlySet<string>;
  readonly concurrencyLimit: number;
  readonly active: number;
}

export interface WorkerSelection {
  readonly preference: readonly WorkerKind[];
  readonly profiles: Readonly<Partial<Record<WorkerKind, WorkerProfile>>>;
  readonly requirements: ReadonlySet<string>;
  readonly unavailable: ReadonlySet<WorkerKind>;
}

export class PolicyBlocker extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
  }
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
    .map((kind) => input.profiles[kind])
    .filter((profile): profile is WorkerProfile => Boolean(profile))
    .filter((profile) => profile.authenticated && profile.available)
    .filter((profile) => profile.active < profile.concurrencyLimit)
    .filter((profile) => !input.unavailable.has(profile.kind))
    .filter((profile) => satisfies(profile, input.requirements));
}

export function selectWorker(input: WorkerSelection): WorkerProfile {
  const selected = eligibleWorkers(input)[0];
  if (!selected) {
    throw new PolicyBlocker("NO_ELIGIBLE_WORKER", "no eligible worker");
  }
  return selected;
}
