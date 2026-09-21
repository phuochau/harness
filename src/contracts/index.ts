import type { EnvironmentDocument } from "./environment.js";
import { validateEnvironment } from "./environment.js";
import type { HarnessLock, LockedDependency } from "./lock.js";
import { validateHarnessLock } from "./lock.js";

export * from "./common.js";
export * from "./controller-command.js";
export * from "./environment.js";
export * from "./events.js";
export * from "./lock.js";
export * from "./task-graph.js";
export * from "./worker-result.js";
export * from "./workflow.js";

const unsafePathPattern = /(^\/)|(^|\/)\.\.?(\/|$)|[\\\0*?\[\]{}]/;

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique`);
  }
}

function expectedPiSources(dependency: LockedDependency): readonly string[] {
  const { source } = dependency;
  if (source.kind === "npm") {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(source.version)) {
      return [];
    }
    return [
      `${source.identity}@${source.version}`,
      `npm:${source.identity}@${source.version}`,
    ];
  }
  if (source.kind === "git" && /^[0-9a-f]{40}$/i.test(source.version)) {
    return [
      `${source.identity}#${source.version}`,
      `git:${source.identity}#${source.version}`,
    ];
  }
  return [];
}

export function validateEnvironmentAndLock(
  environmentValue: unknown,
  lockValue: unknown,
): { environment: EnvironmentDocument; lock: HarnessLock } {
  const environment = validateEnvironment(environmentValue);
  const lock = validateHarnessLock(lockValue);
  assertUnique(
    environment.pi_packages.map((item) => item.id),
    "Pi package IDs",
  );
  assertUnique(
    lock.dependencies.map((item) => item.id),
    "lock dependency IDs",
  );

  for (const requirement of environment.pi_packages) {
    const resources = Object.values(requirement.resources).flat();
    for (const path of resources) {
      if (unsafePathPattern.test(path) || path.startsWith("./")) {
        throw new Error(`unsafe Pi package resource path: ${path}`);
      }
    }
    const matches = lock.dependencies.filter(
      (dependency) => dependency.id === requirement.dependency,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Pi package ${requirement.id} requires exactly one lock dependency ${requirement.dependency}`,
      );
    }
    const dependency = matches[0];
    if (
      !dependency ||
      dependency.kind !== "pi-package" ||
      !dependency.piSource ||
      !expectedPiSources(dependency).includes(dependency.piSource)
    ) {
      throw new Error(
        `lock dependency ${requirement.dependency} is not an exact Pi package source projection`,
      );
    }
  }
  return { environment, lock };
}
