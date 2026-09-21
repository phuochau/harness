import { access, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ProfileDocument } from "../../contracts/profiles.js";
import { resolveProfiles, type LockedProfileResources, type ResolvedProfiles } from "../../config/profiles.js";
import { NodeProcessRunner } from "../../git/process.js";
import { NodePiProcessSupervisor } from "../pi-process/process.js";
import type { PiProcessSupervisor } from "../pi-process/types.js";
import { PiWorkerRuntime } from "../pi-worker/runtime.js";
import { materializeProfile, type ManagedProfileView } from "./materialize.js";
import { managedRuntimePaths } from "./paths.js";
import { projectLocalSubscriptionCredentials } from "./credentials.js";
import { sha256 } from "../../shared/sha256.js";

export interface ManagedPiRuntimeBundle {
  readonly profiles: ResolvedProfiles;
  readonly managedProfiles: Readonly<Record<string, ManagedProfileView>>;
  readonly supervisor: PiProcessSupervisor;
  readonly piExecutable: string;
  readonly piExecutableArgs: readonly string[];
  readonly transportExtensionPath: string;
  readonly workerRuntime: PiWorkerRuntime;
}

export interface ManagedPiRuntimeBaseInput {
  readonly runtimeVersion: string;
  readonly packageRoot: string;
  readonly dataHome?: string;
  readonly ambient?: Readonly<Record<string, string | undefined>>;
  readonly projectCredentials?: boolean;
  readonly expectedPackage?: {
    readonly name: string;
    readonly version: string;
    readonly transportHash?: `sha256:${string}`;
  };
}

async function assertPackageIdentity(input: ManagedPiRuntimeBaseInput): Promise<void> {
  if (input.expectedPackage === undefined) return;
  const value = JSON.parse(await readFile(join(input.packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    value.name !== input.expectedPackage.name ||
    value.version !== input.expectedPackage.version
  ) {
    throw new Error("frozen harness package identity is unavailable");
  }
  if (input.expectedPackage.transportHash !== undefined) {
    const transport = await readFile(
      join(input.packageRoot, "dist", "pi", "worker-transport-extension.js"),
    );
    if (sha256(transport) !== input.expectedPackage.transportHash) {
      throw new Error("frozen harness transport identity is unavailable");
    }
  }
}

async function existing(paths: readonly string[], label: string): Promise<string> {
  for (const path of paths) {
    try { await access(path); return path; } catch {}
  }
  throw new Error(`${label} is not installed; run harness setup and authenticate the profile`);
}

const execFileAsync = promisify(execFile);

async function supportedNode(pathValue: string): Promise<string | undefined> {
  try {
    const path = await realpath(pathValue);
    const { stdout } = await execFileAsync(path, ["--version"], { timeout: 5_000 });
    const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
    if (match === null) return undefined;
    const [major, minor, patch] = match.slice(1).map(Number);
    if (major! > 22 || (major === 22 && (minor! > 22 || (minor === 22 && patch! >= 2)))) return path;
  } catch {}
  return undefined;
}

async function resolveNodeRuntime(pathValue: string): Promise<string> {
  const candidates = [
    process.execPath,
    ...pathValue.split(delimiter).map((directory) => join(directory, process.platform === "win32" ? "node.exe" : "node")),
  ];
  for (const candidate of [...new Set(candidates)]) {
    const supported = await supportedNode(candidate);
    if (supported !== undefined) return supported;
  }
  throw new Error("managed Pi requires Node >=22.22.2; run harness setup with a supported Node runtime");
}

export async function createManagedPiRuntime(input: ManagedPiRuntimeBaseInput & {
  readonly profiles: ProfileDocument;
}): Promise<ManagedPiRuntimeBundle> {
  const ambient = input.ambient ?? process.env;
  const userHome = ambient.HOME ?? homedir();
  const executablePath = ambient.PATH ?? "/usr/bin:/bin";
  const dataHome = input.dataHome ?? ambient.XDG_DATA_HOME ?? join(userHome, ".local", "share");
  const base = managedRuntimePaths({ dataHome, runtimeVersion: input.runtimeVersion, profileId: "planner-codex" });
  const packageModules = join(base.packages, "node_modules");
  const superpowersRoot = join(
    ambient.CODEX_HOME ?? join(userHome, ".codex"),
    "plugins", "cache", "superpowers-dev", "superpowers", "6.4.1", "skills",
  );
  const skillIds = new Set(Object.values(input.profiles.profiles).flatMap((profile) => profile.skills.map((skill) => skill.id)));
  const extensionIds = new Set(Object.values(input.profiles.profiles).flatMap((profile) => profile.extensions));
  const promptIds = new Set(Object.values(input.profiles.profiles).flatMap((profile) => profile.prompt_templates));
  const skills: Record<string, string> = {};
  for (const id of skillIds) {
    const name = id.replace(/^superpowers:/, "");
    skills[id] = await existing([join(superpowersRoot, name, "SKILL.md")], `locked skill ${id}`);
  }
  const extensions: Record<string, string> = {};
  if (extensionIds.has("devin-acp")) {
    extensions["devin-acp"] = await existing([
        join(packageModules, "@tian.zuo", "pi-devin-acp", "index.ts"),
        join(packageModules, "@tian.zuo", "pi-devin-acp", "dist", "index.js"),
      ], "pi-devin-acp");
  }
  if (extensionIds.has("codex-acp")) {
    extensions["codex-acp"] = await existing([
      join(packageModules, "@junghanacs", "pi-shell-acp", "index.ts"),
    ], "pi-shell-acp Codex CLI bridge");
  }
  if (extensionIds.has("claude-bridge")) {
    extensions["claude-bridge"] = await existing([
        join(packageModules, "pi-claude-bridge", "src", "index.ts"),
        join(packageModules, "pi-claude-bridge", "dist", "index.js"),
      ], "pi-claude-bridge");
  }
  const resources: LockedProfileResources = {
    extensions,
    skills,
    promptTemplates: promptIds.has("spec-kit")
      ? { "spec-kit": join(input.packageRoot, "src", "defaults", "prompts", "spec-kit.md") }
      : {},
    mcp: {},
  };
  const profiles = resolveProfiles(input.profiles, resources);
  return createManagedPiRuntimeFromResolved({ ...input, profiles });
}

export async function createManagedPiRuntimeFromResolved(
  input: ManagedPiRuntimeBaseInput & { readonly profiles: ResolvedProfiles },
): Promise<ManagedPiRuntimeBundle> {
  await assertPackageIdentity(input);
  const ambient = input.ambient ?? process.env;
  const userHome = ambient.HOME ?? homedir();
  const executablePath = ambient.PATH ?? "/usr/bin:/bin";
  const dataHome = input.dataHome ?? ambient.XDG_DATA_HOME ?? join(userHome, ".local", "share");
  const base = managedRuntimePaths({ dataHome, runtimeVersion: input.runtimeVersion, profileId: "planner-codex" });
  const packageModules = join(base.packages, "node_modules");
  const profiles = input.profiles;
  const managedProfiles: Record<string, ManagedProfileView> = {};
  for (const profile of Object.values(profiles.byId)) {
    const paths = managedRuntimePaths({ dataHome, runtimeVersion: input.runtimeVersion, profileId: profile.id });
    managedProfiles[profile.id] = await materializeProfile(profile, paths, {
      ambient,
      forwardedKeys: [],
      executablePath,
      retainExtensionSources: true,
    });
    if (input.projectCredentials === true) {
      await projectLocalSubscriptionCredentials({ profile, paths, ambient });
    }
  }
  const supervisor = new NodePiProcessSupervisor();
  const piCli = await existing([
    join(packageModules, ".bin", "pi"),
  ], "managed Pi coding agent");
  const piCliReal = await realpath(piCli);
  const piExecutable = await resolveNodeRuntime(executablePath);
  const piExecutableArgs = [piCliReal] as const;
  const transportExtensionPath = join(input.packageRoot, "dist", "pi", "worker-transport-extension.js");
  await access(transportExtensionPath);
  const workerRuntime = new PiWorkerRuntime({
    profiles,
    managedProfiles,
    supervisor,
    piExecutable,
    piExecutableArgs,
    transportExtensionPath,
    process: new NodeProcessRunner(),
  });
  return Object.freeze({ profiles, managedProfiles, supervisor, piExecutable, piExecutableArgs, transportExtensionPath, workerRuntime });
}
