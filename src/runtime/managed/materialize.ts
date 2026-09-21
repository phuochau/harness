import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { ResolvedProfile } from "../../config/profiles.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { sha256 } from "../../shared/sha256.js";
import { buildManagedEnvironment } from "./environment.js";
import type { ManagedRuntimePaths } from "./paths.js";

export interface ManagedProfileView {
  readonly extensionPaths: readonly string[];
  readonly piSkillPaths: readonly string[];
  readonly providerSkillPaths: readonly string[];
  readonly promptTemplatePaths: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly receiptHash: `sha256:${string}`;
}

export interface MaterializeProfileOptions {
  readonly ambient?: Readonly<Record<string, string | undefined>>;
  readonly forwardedKeys?: readonly string[];
  readonly executablePath?: string;
}

async function assertCopyableTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`managed resource must not be a symlink: ${path}`);
  if (info.isFile()) return;
  if (!info.isDirectory()) throw new Error(`managed resource is not a regular tree: ${path}`);
  for (const entry of await readdir(path)) {
    await assertCopyableTree(join(path, entry));
  }
}

async function copyResource(source: string, target: string): Promise<void> {
  await assertCopyableTree(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await cp(source, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
}

const preservedCredentialPaths = [
  "pi-agent/auth.json",
  "xdg-config/devin/config.json",
  "home/.claude.json",
  "home/.claude/.credentials.json",
] as const;

async function preserveCredentials(profileRoot: string, staging: string): Promise<void> {
  for (const child of preservedCredentialPaths) {
    const source = join(profileRoot, child);
    try {
      const info = await lstat(source);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
        throw new Error(`managed credential is not a bounded regular file: ${child}`);
      }
      const target = join(staging, child);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await cp(source, target, { errorOnExist: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function resourceName(id: string): string {
  const readable = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${readable || "resource"}-${sha256(id).slice(7, 19)}`;
}

function stagePath(staging: string, paths: ManagedRuntimePaths, finalPath: string): string {
  const child = relative(paths.profileRoot, finalPath);
  if (child === "" || child === ".." || child.startsWith("../")) {
    throw new Error(`profile resource escapes managed profile root: ${finalPath}`);
  }
  return join(staging, child);
}

async function replaceProfileAtomically(
  staging: string,
  profileRoot: string,
): Promise<void> {
  const backup = `${profileRoot}.backup-${randomUUID()}`;
  let hadExisting = false;
  try {
    const current = await lstat(profileRoot);
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new Error(`managed profile target is not a real directory: ${profileRoot}`);
    }
    await rename(profileRoot, backup);
    hadExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, profileRoot);
  } catch (error) {
    if (hadExisting) await rename(backup, profileRoot);
    throw error;
  }
  if (hadExisting) await rm(backup, { recursive: true, force: true });
}

export async function materializeProfile(
  profile: ResolvedProfile,
  paths: ManagedRuntimePaths,
  options: MaterializeProfileOptions = {},
): Promise<ManagedProfileView> {
  if (basename(paths.profileRoot) !== profile.id) {
    throw new Error("managed paths do not belong to the resolved profile");
  }
  if (profile.mcp.length > 0) {
    throw new Error("MCP projection is not implemented for managed profiles");
  }
  const environment = buildManagedEnvironment({
    profile,
    paths,
    ambient: options.ambient ?? {},
    forwardedKeys: options.forwardedKeys ?? [],
    executablePath: options.executablePath ?? "/usr/bin:/bin",
  });

  await mkdir(dirname(paths.profileRoot), { recursive: true, mode: 0o700 });
  const staging = `${paths.profileRoot}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const finalDirectory of [
      paths.profileHome,
      paths.piAgentDir,
      paths.xdgConfigHome,
      paths.xdgDataHome,
    ]) {
      await mkdir(stagePath(staging, paths, finalDirectory), {
        recursive: true,
        mode: 0o700,
      });
    }
    await preserveCredentials(paths.profileRoot, staging);

    const extensionPaths: string[] = [];
    for (const [index, source] of profile.extensions.entries()) {
      const finalPath = join(
        paths.profileRoot,
        "resources",
        "extensions",
        `${index}-${resourceName(basename(source))}`,
      );
      await copyResource(source, stagePath(staging, paths, finalPath));
      extensionPaths.push(finalPath);
    }

    const piSkillPaths: string[] = [];
    const providerSkillPaths: string[] = [];
    const claudeSkills: Array<{ id: string; content: string }> = [];
    for (const skill of profile.skills) {
      if (basename(skill.path) !== "SKILL.md") {
        throw new Error(`skill ${skill.id} must resolve to SKILL.md`);
      }
      const name = resourceName(skill.id);
      const finalDirectory = join(paths.profileRoot, "resources", "skills", name);
      const finalSkillPath = join(finalDirectory, "SKILL.md");
      await copyResource(dirname(skill.path), stagePath(staging, paths, finalDirectory));
      if (skill.targets.includes("pi")) piSkillPaths.push(finalSkillPath);
      if (skill.targets.includes("provider")) {
        if (profile.family === "devin") {
          const providerDirectory = join(
            paths.profileHome,
            ".agents",
            "skills",
            name,
          );
          await copyResource(
            dirname(skill.path),
            stagePath(staging, paths, providerDirectory),
          );
          providerSkillPaths.push(join(providerDirectory, "SKILL.md"));
        } else if (profile.family === "claude") {
          providerSkillPaths.push(finalSkillPath);
          claudeSkills.push({
            id: skill.id,
            content: await readFile(skill.path, "utf8"),
          });
        } else {
          throw new Error(`provider skill projection is unsupported for ${profile.family}`);
        }
      }
    }

    const promptTemplatePaths: string[] = [];
    for (const [index, source] of profile.promptTemplates.entries()) {
      const finalPath = join(
        paths.profileRoot,
        "resources",
        "prompt-templates",
        `${index}-${resourceName(basename(source))}.md`,
      );
      await copyResource(source, stagePath(staging, paths, finalPath));
      promptTemplatePaths.push(finalPath);
    }

    if (profile.family === "claude") {
      const configuration = {
        strictMcpConfig: true,
        askClaude: { enabled: false },
        autoMemoryEnabled: false,
        mcpServers: {},
        forwardedSkills: claudeSkills,
      };
      await writeFile(
        stagePath(staging, paths, join(paths.piAgentDir, "claude-bridge.json")),
        `${JSON.stringify(configuration, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }

    const receiptBody = {
      schemaVersion: 1,
      profileId: profile.id,
      profileHash: profile.hash,
      extensions: extensionPaths.map((path) => relative(paths.profileRoot, path)),
      piSkills: piSkillPaths.map((path) => relative(paths.profileRoot, path)),
      providerSkills: providerSkillPaths.map((path) =>
        relative(paths.profileRoot, path),
      ),
      promptTemplates: promptTemplatePaths.map((path) =>
        relative(paths.profileRoot, path),
      ),
    };
    const receiptHash = sha256(canonicalJson(receiptBody));
    await writeFile(
      join(staging, "receipt.json"),
      `${JSON.stringify({ ...receiptBody, receiptHash }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await replaceProfileAtomically(staging, paths.profileRoot);

    return deepFreeze({
      extensionPaths,
      piSkillPaths,
      providerSkillPaths,
      promptTemplatePaths,
      environment,
      receiptHash,
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
