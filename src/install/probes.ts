import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
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
      : capability.expectedVersion !== undefined && version !== capability.expectedVersion
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
