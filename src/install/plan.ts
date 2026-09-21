import { createHash } from "node:crypto";
import type { HarnessLock, LockedDependency } from "../contracts/lock.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { recipeFor } from "./recipes.js";
import { OFFICIAL_NPM_REGISTRY } from "./recipes.js";
import type { CapabilityReport, EffectivePolicy, TrustedSource } from "./types.js";

export interface SkippedInstallStep {
  readonly id: string;
  readonly mode: "skipped";
  readonly blocking: false;
  readonly reason: string;
}

export interface ManualInstallStep {
  readonly id: string;
  readonly mode: "manual";
  readonly blocking: true;
  readonly reason: string;
}

export interface AutomaticInstallStep {
  readonly id: string;
  readonly mode: "automatic";
  readonly blocking: true;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly cwd: "trusted-install-root";
  readonly scope: "project" | "managed" | "global";
  readonly source: TrustedSource;
  readonly expectedVersion: string;
  readonly expectedMutations: readonly string[];
  readonly probeAfter: string;
  readonly rollback: string;
}

export type InstallStep = SkippedInstallStep | ManualInstallStep | AutomaticInstallStep;

export interface InstallPlan {
  readonly schemaVersion: 1;
  readonly lockHash: string;
  readonly planHash: string;
  readonly warnings: readonly string[];
  readonly steps: readonly InstallStep[];
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function versionSatisfies(actual: string | undefined, required: string): boolean {
  if (actual === undefined) return false;
  if (required === "system") return true;
  if (!required.startsWith(">=")) return actual === required;
  const parse = (value: string): readonly number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match === null
      ? undefined
      : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(actual);
  const right = parse(required.slice(2));
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

type InstallPlanBody = Omit<InstallPlan, "planHash">;

export function installPlanHash(plan: InstallPlanBody): string {
  return digest(plan);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function orderedDependencies(lock: HarnessLock): readonly LockedDependency[] {
  const byId = new Map<string, LockedDependency>();
  for (const dependency of lock.dependencies) {
    if (byId.has(dependency.id)) throw new Error(`duplicate dependency ${dependency.id}`);
    byId.set(dependency.id, dependency);
  }
  for (const dependency of lock.dependencies) {
    for (const parent of dependency.dependsOn) {
      if (!byId.has(parent)) {
        throw new Error(`dependency ${dependency.id} references unknown dependency ${parent}`);
      }
    }
  }

  const remaining = new Map(
    lock.dependencies.map((dependency) => [dependency.id, new Set(dependency.dependsOn)]),
  );
  const ordered: LockedDependency[] = [];
  while (remaining.size > 0) {
    const ready = lock.dependencies.filter(
      (dependency) => remaining.has(dependency.id) && remaining.get(dependency.id)!.size === 0,
    );
    if (ready.length === 0) throw new Error("dependency installation graph contains a cycle");
    for (const dependency of ready) {
      ordered.push(dependency);
      remaining.delete(dependency.id);
      for (const parents of remaining.values()) parents.delete(dependency.id);
    }
  }
  return ordered;
}

function trustedSource(dependency: LockedDependency): TrustedSource | undefined {
  if (dependency.source.kind === "manual") return undefined;
  return {
    kind: dependency.source.kind,
    identity: dependency.source.identity,
    version: dependency.source.version,
    integrity: dependency.source.integrity,
    ...(dependency.source.kind === "npm" ? { registry: OFFICIAL_NPM_REGISTRY } : {}),
  };
}

export function createInstallPlan(
  lock: HarnessLock,
  report: CapabilityReport,
  policy: EffectivePolicy,
  options: {
    readonly repair?: boolean;
    readonly managedDependencyIds?: ReadonlySet<string>;
    readonly managedRoot?: string;
  } = {},
): InstallPlan {
  const warnings: string[] = [];
  const steps: InstallStep[] = [];

  for (const dependency of orderedDependencies(lock)) {
    const observed = report.byId[dependency.id];
    if (
      observed?.status === "present" &&
      versionSatisfies(observed.version, dependency.version)
    ) {
      steps.push({
        id: dependency.id,
        mode: "skipped",
        blocking: false,
        reason: `exact version ${dependency.version} is present`,
      });
      continue;
    }

    if (
      observed !== undefined &&
      (
        ["unverifiable", "wrong_source", "unexpected", "policy_violation", "missing_auth"].includes(
          observed.status,
        ) ||
        (observed.status === "disabled" && options.repair !== true)
      )
    ) {
      steps.push({
        id: dependency.id,
        mode: "manual",
        blocking: true,
        reason: `current capability state ${observed.status} is unsafe to replace automatically`,
      });
      continue;
    }

    const source = trustedSource(dependency);
    if (source === undefined || !policy.allows(source)) {
      steps.push({
        id: dependency.id,
        mode: "manual",
        blocking: true,
        reason: source === undefined
          ? "dependency has no machine-verifiable source"
          : "source is not allowed by the effective trust policy",
      });
      continue;
    }

    const recipe = recipeFor(dependency, source, {
      managed: options.managedDependencyIds?.has(dependency.id) === true,
      ...(options.managedRoot === undefined
        ? {}
        : { managedRoot: options.managedRoot }),
    });
    if (recipe.mode === "manual") {
      steps.push({ id: dependency.id, mode: "manual", blocking: true, reason: recipe.reason });
      continue;
    }
    if (dependency.kind === "pi-package") {
      warnings.push(
        `Pi package ${dependency.id} can execute arbitrary code; inspect the exact locked source before approval.`,
      );
    }
    steps.push({
      id: dependency.id,
      mode: "automatic",
      blocking: true,
      ...recipe.recipe,
      source,
      expectedVersion: dependency.version,
      probeAfter: dependency.id,
    });
  }

  const dependencyIds = new Set(lock.dependencies.map((item) => item.id));
  for (const result of Object.values(report.byId).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (
      !dependencyIds.has(result.id) &&
      (result.status === "unexpected" || result.status === "policy_violation")
    ) {
      steps.push({
        id: result.id,
        mode: "manual",
        blocking: true,
        reason: `probe reported ${result.status}; automatic installation is disabled`,
      });
    }
  }

  const body = {
    schemaVersion: 1 as const,
    lockHash: digest(lock),
    warnings,
    steps,
  };
  return deepFreeze({ ...body, planHash: installPlanHash(body) });
}
