import { join, resolve } from "node:path";
import { deepFreeze } from "../../shared/deep-freeze.js";

export interface ManagedRuntimePaths {
  readonly root: string;
  readonly packages: string;
  readonly skills: string;
  readonly profileRoot: string;
  readonly profileHome: string;
  readonly piAgentDir: string;
  readonly xdgConfigHome: string;
  readonly xdgDataHome: string;
}

const safeIdentifier = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function assertSafeIdentifier(value: string, label: string): void {
  if (
    !safeIdentifier.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`${label} must be a safe identifier`);
  }
}

export function managedPackagesPath(input: {
  readonly dataHome: string;
  readonly runtimeVersion: string;
}): string {
  assertSafeIdentifier(input.runtimeVersion, "runtime version");
  if (input.dataHome.length === 0 || input.dataHome.includes("\0")) {
    throw new Error("data home must be a non-empty path");
  }
  return join(resolve(input.dataHome), "pi-harness", "runtimes", input.runtimeVersion, "packages");
}

export function managedRuntimePaths(input: {
  readonly dataHome: string;
  readonly runtimeVersion: string;
  readonly profileId: string;
}): ManagedRuntimePaths {
  assertSafeIdentifier(input.runtimeVersion, "runtime version");
  assertSafeIdentifier(input.profileId, "profile ID");
  if (input.dataHome.length === 0 || input.dataHome.includes("\0")) {
    throw new Error("data home must be a non-empty path");
  }
  const packages = managedPackagesPath(input);
  const root = resolve(packages, "..");
  const profileRoot = join(root, "profiles", input.profileId);
  return deepFreeze({
    root,
    packages,
    skills: join(root, "skills"),
    profileRoot,
    profileHome: join(profileRoot, "home"),
    piAgentDir: join(profileRoot, "pi-agent"),
    xdgConfigHome: join(profileRoot, "xdg-config"),
    xdgDataHome: join(profileRoot, "xdg-data"),
  });
}
