import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { EnvironmentDocument, HarnessLock } from "../contracts/index.js";
import { sha256 } from "../shared/sha256.js";
import type { ProbeResult } from "./types.js";

const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 128;

async function boundedText(path: string, maximum: number): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`symbolic link is not trusted: ${path}`);
  if (!info.isFile() || info.size > maximum) {
    throw new Error(`metadata is not a bounded regular file: ${path}`);
  }
  return readFile(path, "utf8");
}

async function optionalJson(path: string, maximum: number): Promise<any | undefined> {
  try {
    return JSON.parse(await boundedText(path, maximum));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}

async function packageDirectories(cacheRoot: string): Promise<readonly string[]> {
  const result: string[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_CACHE_ENTRIES) throw new Error("Pi package cache entry limit exceeded");
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Pi package cache contains symlink: ${path}`);
      if (!info.isDirectory()) continue;
      if (await optionalJson(join(path, "package.json"), MAX_METADATA_BYTES)) {
        result.push(path);
      }
      await walk(path, depth + 1);
    }
  };
  try {
    await walk(cacheRoot, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return result;
}

async function resourceState(packageRoot: string, resource: string): Promise<"present" | "missing"> {
  const target = resolve(packageRoot, resource);
  if (!inside(packageRoot, target)) throw new Error(`resource escapes package: ${resource}`);
  let current = packageRoot;
  for (const segment of resource.split("/")) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`resource uses symlink: ${resource}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
  const canonical = await realpath(target);
  if (!inside(await realpath(packageRoot), canonical)) {
    throw new Error(`resource resolves outside package: ${resource}`);
  }
  return "present";
}

export async function probePiPackages(input: {
  readonly root: string;
  readonly environment: EnvironmentDocument;
  readonly lock: HarnessLock;
}): Promise<Readonly<Record<string, ProbeResult>>> {
  const results: Record<string, ProbeResult> = {};
  const settingsPath = join(input.root, ".pi/settings.json");
  let settings: any;
  try {
    settings = await optionalJson(settingsPath, MAX_SETTINGS_BYTES);
  } catch (error) {
    return {
      "pi-settings:project": {
        id: "pi-settings:project",
        status: "unverifiable",
        evidence: [error instanceof Error ? error.message : String(error)],
      },
    };
  }
  if (settings === undefined || typeof settings !== "object" || !Array.isArray(settings.packages)) {
    return {
      "pi-settings:project": {
        id: "pi-settings:project",
        status: "missing",
      },
    };
  }
  if (settings.packages.length > MAX_CACHE_ENTRIES) {
    return {
      "pi-settings:project": {
        id: "pi-settings:project",
        status: "unverifiable",
        evidence: ["Pi settings package entry limit exceeded"],
      },
    };
  }
  if (settings.npmCommand !== undefined || settings.packageManagerCommand !== undefined) {
    results["pi-settings:npm-command"] = {
      id: "pi-settings:npm-command",
      status: "policy_violation",
      evidence: ["project settings may not select package-manager executables"],
    };
  }
  const declaredSources = new Set<string>();
  const cacheRoot = join(input.root, ".pi/npm");
  let directories: readonly string[];
  try {
    directories = await packageDirectories(cacheRoot);
  } catch (error) {
    for (const requirement of input.environment.pi_packages.filter(
      (item) => item.scope === "project",
    )) {
      results[`pi-package:${requirement.id}`] = {
        id: `pi-package:${requirement.id}`,
        status: "unverifiable",
        evidence: [error instanceof Error ? error.message : String(error)],
      };
    }
    return results;
  }
  for (const requirement of input.environment.pi_packages.filter(
    (item) => item.scope === "project",
  )) {
    const id = `pi-package:${requirement.id}`;
    const dependency = input.lock.dependencies.find(
      (item) => item.id === requirement.dependency,
    )!;
    declaredSources.add(dependency.piSource!);
    const configured = settings.packages.filter(
      (item: any) => typeof item === "object" && item?.source === dependency.piSource,
    );
    if (configured.length !== 1) {
      const sameIdentity = settings.packages.some(
        (item: any) =>
          typeof item === "object" &&
          typeof item?.source === "string" &&
          item.source.includes(dependency.source.identity),
      );
      results[id] = { id, status: sameIdentity ? "wrong_source" : "missing" };
      continue;
    }
    const packageSettings = configured[0];
    if (
      packageSettings.npmCommand !== undefined ||
      packageSettings.packageManagerCommand !== undefined
    ) {
      results[id] = {
        id,
        status: "policy_violation",
        evidence: ["project package entry may not select package-manager executables"],
      };
      continue;
    }
    const disabled = (["extensions", "skills", "prompts", "themes"] as const).some(
      (type) => {
        const filters = packageSettings[type];
        const expected = (requirement.resources[type] ?? [])
          .map((path) => `+${path}`)
          .sort();
        return (
          !Array.isArray(filters) ||
          filters.some((item: unknown) => typeof item !== "string") ||
          JSON.stringify([...filters].sort()) !== JSON.stringify(expected)
        );
      },
    );
    if (disabled) {
      results[id] = { id, status: "disabled" };
      continue;
    }
    let packageRoot: string | undefined;
    for (const directory of directories) {
      const metadata = await optionalJson(join(directory, "package.json"), MAX_METADATA_BYTES);
      if (
        metadata?.name === dependency.source.identity &&
        metadata?.version === dependency.source.version
      ) {
        packageRoot = directory;
        break;
      }
    }
    if (packageRoot === undefined) {
      results[id] = { id, status: "missing" };
      continue;
    }
    const missing: string[] = [];
    try {
      for (const resource of Object.values(requirement.resources).flat()) {
        if ((await resourceState(packageRoot, resource)) === "missing") missing.push(resource);
      }
    } catch (error) {
      results[id] = {
        id,
        status: "unverifiable",
        evidence: [error instanceof Error ? error.message : String(error)],
      };
      continue;
    }
    results[id] = missing.length === 0
      ? { id, status: "present", version: dependency.version }
      : { id, status: "missing", missingResources: missing.sort() };
  }
  for (const item of settings.packages) {
    const source = typeof item === "object" && item !== null ? item.source : undefined;
    if (typeof source === "string" && !declaredSources.has(source)) {
      const id = `pi-package:unexpected:${sha256(source)}`;
      results[id] = {
        id,
        status: "unexpected",
      };
    }
  }
  return results;
}
