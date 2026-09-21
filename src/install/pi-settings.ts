import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "../shared/canonical-json.js";

export type PiResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface PiPackageSettingsEntry {
  readonly source: string;
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly themes: readonly string[];
}

export interface MergePiSettingsInput {
  readonly root: string;
  readonly entry: PiPackageSettingsEntry;
  readonly declaredSources: readonly string[];
  readonly repair?: boolean;
}

export class PiSettingsConflictError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalized(entry: PiPackageSettingsEntry): PiPackageSettingsEntry {
  if (!entry.source.startsWith("npm:") && !entry.source.startsWith("git:")) {
    throw new PiSettingsConflictError("Pi package source must be an exact npm or Git source");
  }
  const result: Record<PiResourceType, readonly string[]> = {
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  for (const type of Object.keys(result) as PiResourceType[]) {
    const filters = [...entry[type]].sort();
    if (
      new Set(filters).size !== filters.length ||
      filters.some((value) => {
        if (!/^\+[A-Za-z0-9._@/-]+$/.test(value)) return true;
        const path = value.slice(1);
        return path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "");
      })
    ) {
      throw new PiSettingsConflictError(`${type} must contain unique exact +path filters`);
    }
    result[type] = filters;
  }
  return { source: entry.source, ...result };
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) {
      throw new PiSettingsConflictError("Pi settings must be a bounded regular file");
    }
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new PiSettingsConflictError("Pi settings must be an object");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof PiSettingsConflictError) throw error;
    throw new PiSettingsConflictError(
      `Pi settings cannot be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await chmod(path, 0o600);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function mergePiPackageSettings(input: MergePiSettingsInput): Promise<void> {
  const path = join(input.root, ".pi/settings.json");
  try {
    if ((await lstat(join(input.root, ".pi"))).isSymbolicLink()) {
      throw new PiSettingsConflictError("refusing to write through a symbolic-link .pi directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const settings = await readSettings(path);
  if (settings.npmCommand !== undefined || settings.packageManagerCommand !== undefined) {
    throw new PiSettingsConflictError("project settings may not override package-manager commands");
  }
  const packages = settings.packages ?? [];
  if (!Array.isArray(packages) || packages.some((item) => !isRecord(item))) {
    throw new PiSettingsConflictError("Pi settings packages must be an array of objects");
  }
  const declared = new Set(input.declaredSources);
  if (!declared.has(input.entry.source)) {
    throw new PiSettingsConflictError("target Pi package is not declared by the environment");
  }
  for (const item of packages as Record<string, unknown>[]) {
    if (typeof item.source !== "string" || !declared.has(item.source)) {
      throw new PiSettingsConflictError("Pi settings contain an unexpected package entry");
    }
  }

  const desired = normalized(input.entry);
  const matches = (packages as Record<string, unknown>[]).filter(
    (item) => item.source === desired.source,
  );
  if (matches.length > 1) throw new PiSettingsConflictError("Pi package entry is duplicated");
  if (matches.length === 1 && canonicalJson(matches[0]) !== canonicalJson(desired)) {
    if (input.repair !== true) {
      throw new PiSettingsConflictError("Pi package entry is customized; explicit repair is required");
    }
  }
  const nextPackages = (packages as Record<string, unknown>[]).filter(
    (item) => item.source !== desired.source,
  );
  nextPackages.push(desired as unknown as Record<string, unknown>);
  await atomicJson(path, { ...settings, packages: nextPackages });
}
