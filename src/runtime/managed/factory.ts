import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProfileDocument } from "../../contracts/profiles.js";
import { resolveProfiles, type LockedProfileResources, type ResolvedProfiles } from "../../config/profiles.js";
import { NodeProcessRunner } from "../../git/process.js";
import { NodePiProcessSupervisor } from "../pi-process/process.js";
import type { PiProcessSupervisor } from "../pi-process/types.js";
import { PiWorkerRuntime } from "../pi-worker/runtime.js";
import { materializeProfile, type ManagedProfileView } from "./materialize.js";
import { managedRuntimePaths } from "./paths.js";

export interface ManagedPiRuntimeBundle {
  readonly profiles: ResolvedProfiles;
  readonly managedProfiles: Readonly<Record<string, ManagedProfileView>>;
  readonly supervisor: PiProcessSupervisor;
  readonly piExecutable: string;
  readonly transportExtensionPath: string;
  readonly workerRuntime: PiWorkerRuntime;
}

async function existing(paths: readonly string[], label: string): Promise<string> {
  for (const path of paths) {
    try { await access(path); return path; } catch {}
  }
  throw new Error(`${label} is not installed; run harness setup and authenticate the profile`);
}

export async function createManagedPiRuntime(input: {
  readonly profiles: ProfileDocument;
  readonly runtimeVersion: string;
  readonly packageRoot: string;
  readonly dataHome?: string;
  readonly ambient?: Readonly<Record<string, string | undefined>>;
}): Promise<ManagedPiRuntimeBundle> {
  const dataHome = input.dataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const base = managedRuntimePaths({ dataHome, runtimeVersion: input.runtimeVersion, profileId: "planner-codex" });
  const packageModules = join(base.packages, "node_modules");
  const superpowersRoot = join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
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
  const managedProfiles: Record<string, ManagedProfileView> = {};
  for (const profile of Object.values(profiles.byId)) {
    const paths = managedRuntimePaths({ dataHome, runtimeVersion: input.runtimeVersion, profileId: profile.id });
    managedProfiles[profile.id] = await materializeProfile(profile, paths, {
      ambient: input.ambient ?? process.env,
      forwardedKeys: [],
      executablePath: process.env.PATH ?? "/usr/bin:/bin",
    });
  }
  const supervisor = new NodePiProcessSupervisor();
  const piExecutable = await existing([
    join(packageModules, ".bin", "pi"),
  ], "managed Pi coding agent");
  const transportExtensionPath = join(input.packageRoot, "dist", "pi", "worker-transport-extension.js");
  await access(transportExtensionPath);
  const workerRuntime = new PiWorkerRuntime({
    profiles,
    managedProfiles,
    supervisor,
    piExecutable,
    transportExtensionPath,
    process: new NodeProcessRunner(),
  });
  return Object.freeze({ profiles, managedProfiles, supervisor, piExecutable, transportExtensionPath, workerRuntime });
}
