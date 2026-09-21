import { lstat, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { loadEnvironment } from "../config/load.js";
import { validateEnvironmentAndLock } from "../contracts/index.js";
import { probePiPackages } from "./pi-package-probe.js";
import type {
  CapabilityReport,
  ExecutableCapability,
  ProbeEnvironmentContext,
  ProbeResult,
} from "./types.js";

const NODE_FLOOR = [22, 22, 2] as const;

function parseSemver(value: string): readonly [number, number, number] | undefined {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(
  value: readonly [number, number, number],
  floor: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (value[index]! > floor[index]!) return true;
    if (value[index]! < floor[index]!) return false;
  }
  return true;
}

export function probeNodeVersion(stdout: string): {
  readonly id: "node";
  readonly status: "present" | "wrong_version" | "unverifiable";
  readonly version?: string;
  readonly required: ">=22.22.2";
} {
  const parsed = parseSemver(stdout);
  if (parsed === undefined) {
    return { id: "node", status: "unverifiable", required: ">=22.22.2" };
  }
  const version = parsed.join(".");
  return {
    id: "node",
    status: atLeast(parsed, NODE_FLOOR) ? "present" : "wrong_version",
    version,
    required: ">=22.22.2",
  };
}

export async function probeExecutable(
  process: ProbeEnvironmentContext["process"],
  capability: ExecutableCapability,
): Promise<readonly ProbeResult[]> {
  const result = await process.run(
    capability.command,
    capability.versionArgs,
    { shell: false, timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) return [{ id: capability.id, status: "missing" }];
  const version = capability.parseVersion(result.stdout);
  const versionResult: ProbeResult =
    version === undefined
      ? { id: capability.id, status: "unverifiable" }
      : capability.expectedVersion !== undefined &&
          !matchesExpectedVersion(version, capability.expectedVersion)
        ? { id: capability.id, status: "wrong_version", version }
        : { id: capability.id, status: "present", version };
  if (capability.auth === undefined) return [versionResult];
  const auth = await process.run(capability.command, capability.auth.args, {
    shell: false,
    timeoutMs: 10_000,
  });
  const authenticated =
    auth.exitCode === 0 && capability.auth.isAuthenticated(auth.stdout, auth.stderr);
  return [
    versionResult,
    {
      id: `auth:${capability.id}`,
      status: authenticated ? "present" : "missing_auth",
    },
  ];
}

function matchesExpectedVersion(version: string, expected: string): boolean {
  if (!expected.startsWith(">=")) return version === expected;
  const actual = parseSemver(version);
  const floor = parseSemver(expected.slice(2));
  return actual !== undefined && floor !== undefined && atLeast(actual, floor);
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`);
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  if (!inside(root, target)) throw new Error("managed package path escapes its root");
  const child = relative(root, target);
  let current = root;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("managed package root is not a real directory");
  }
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`managed package path uses symlink: ${current}`);
  }
}

function managedDependencyIds(
  environment: Awaited<ReturnType<typeof loadEnvironment>>,
  lock: ReturnType<typeof validateEnvironmentAndLock>["lock"],
): ReadonlySet<string> {
  const byId = new Map(lock.dependencies.map((item) => [item.id, item]));
  const selected = new Set(
    environment.pi_packages
      .filter((item) => item.scope === "managed")
      .map((item) => item.dependency),
  );
  const visit = (id: string): void => {
    const dependency = byId.get(id);
    if (dependency === undefined) return;
    for (const parent of dependency.dependsOn) {
      if (selected.has(parent)) continue;
      selected.add(parent);
      visit(parent);
    }
  };
  for (const id of [...selected]) visit(id);
  return selected;
}

async function probeManagedPackages(
  root: string,
  environment: Awaited<ReturnType<typeof loadEnvironment>>,
  lock: ReturnType<typeof validateEnvironmentAndLock>["lock"],
): Promise<Readonly<Record<string, ProbeResult>>> {
  const output: Record<string, ProbeResult> = {};
  let packageLock: { packages?: Record<string, { integrity?: unknown }> };
  try {
    const lockPath = join(root, "package-lock.json");
    await assertNoSymlinkPath(root, lockPath);
    const lockInfo = await lstat(lockPath);
    if (!lockInfo.isFile() || lockInfo.size > 2 * 1024 * 1024) {
      throw new Error("managed package lock is not a bounded regular file");
    }
    packageLock = JSON.parse(await readFile(lockPath, "utf8")) as typeof packageLock;
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unverifiable";
    for (const id of managedDependencyIds(environment, lock)) {
      const dependency = lock.dependencies.find((item) => item.id === id)!;
      if (dependency.source.kind === "npm") {
        output[id] = {
          id,
          status,
          ...(status === "unverifiable"
            ? { evidence: [error instanceof Error ? error.message : String(error)] }
            : {}),
        };
      }
    }
    return output;
  }
  const requirements = new Map(
    environment.pi_packages
      .filter((item) => item.scope === "managed")
      .map((item) => [item.dependency, item]),
  );
  for (const id of managedDependencyIds(environment, lock)) {
    const dependency = lock.dependencies.find((item) => item.id === id)!;
    if (dependency.source.kind !== "npm") continue;
    const packageRoot = join(root, "node_modules", dependency.source.identity);
    try {
      await assertNoSymlinkPath(root, packageRoot);
      const metadataPath = join(packageRoot, "package.json");
      const info = await lstat(metadataPath);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 64 * 1024) {
        throw new Error("managed package metadata is not a bounded regular file");
      }
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (metadata.name !== dependency.source.identity) {
        output[id] = { id, status: "wrong_source" };
        continue;
      }
      const lockKey = `node_modules/${dependency.source.identity}`;
      if (
        packageLock.packages?.[lockKey]?.integrity !== dependency.source.integrity
      ) {
        output[id] = { id, status: "wrong_source", version: dependency.version };
        continue;
      }
      if (metadata.version !== dependency.version) {
        output[id] = {
          id,
          status: "wrong_version",
          ...(typeof metadata.version === "string" ? { version: metadata.version } : {}),
        };
        continue;
      }
      const missingResources: string[] = [];
      for (const resource of Object.values(requirements.get(id)?.resources ?? {}).flat()) {
        try {
          await assertNoSymlinkPath(packageRoot, join(packageRoot, resource));
        } catch {
          missingResources.push(resource);
        }
      }
      output[id] = missingResources.length === 0
        ? { id, status: "present", version: dependency.version }
        : { id, status: "missing", version: dependency.version, missingResources };
    } catch (error) {
      output[id] = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { id, status: "missing" }
        : {
            id,
            status: "unverifiable",
            evidence: [error instanceof Error ? error.message : String(error)],
          };
    }
  }
  return output;
}

async function machineCommandProbe(
  context: ProbeEnvironmentContext,
): Promise<ProbeResult | undefined> {
  if (context.machineSettingsPath === undefined) return undefined;
  try {
    const info = await lstat(context.machineSettingsPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) {
      return { id: "pi-settings:machine-npm-command", status: "unverifiable" };
    }
    const settings = JSON.parse(await readFile(context.machineSettingsPath, "utf8"));
    const command = settings.npmCommand ?? settings.packageManagerCommand;
    if (command === undefined) return undefined;
    if (!Array.isArray(command) || command.some((part) => typeof part !== "string")) {
      return { id: "pi-settings:machine-npm-command", status: "unverifiable" };
    }
    return {
      id: "pi-settings:machine-npm-command",
      status: context.allowMachinePackageCommand?.(command) === true
        ? "present"
        : "policy_violation",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { id: "pi-settings:machine-npm-command", status: "unverifiable" };
  }
}

export async function probeEnvironment(
  context: ProbeEnvironmentContext,
): Promise<CapabilityReport> {
  const environment = await loadEnvironment(join(context.root, ".harness/environment.yaml"));
  const lockText = await readFile(join(context.root, ".harness/harness.lock"), "utf8");
  const { lock } = validateEnvironmentAndLock(environment, parse(lockText));
  const byId: Record<string, ProbeResult> = {
    ...(await probePiPackages({ root: context.root, environment, lock })),
    ...(context.managedPackagesRoot === undefined
      ? {}
      : await probeManagedPackages(context.managedPackagesRoot, environment, lock)),
  };
  for (const capability of context.capabilities) {
    for (const result of await probeExecutable(context.process, capability)) {
      byId[result.id] = result;
    }
  }
  const machine = await machineCommandProbe(context);
  if (machine !== undefined) byId[machine.id] = machine;
  return { byId };
}
