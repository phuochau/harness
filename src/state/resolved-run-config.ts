import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { CompiledWorkflow } from "../config/compile.js";
import { contentRevision } from "../config/hash.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { deepFreeze } from "../shared/deep-freeze.js";

export interface ProfileCapabilitySnapshotEntry {
  readonly available: boolean;
  readonly evidence: readonly string[];
}

export type ProfileCapabilitySnapshot = Readonly<
  Record<string, ProfileCapabilitySnapshotEntry>
>;

export interface ResolvedRunConfig {
  readonly schemaVersion: 1;
  readonly runtime: {
    readonly harnessVersion: string;
    readonly packageName: string;
    readonly packageVersion: string;
    readonly packageRoot: string;
    readonly transportHash: `sha256:${string}`;
    readonly runtimeHash: `sha256:${string}`;
  };
  readonly workflow: CompiledWorkflow;
  readonly commands: Readonly<Record<string, readonly string[]>>;
  readonly profileCapabilities?: ProfileCapabilitySnapshot;
}

const digest = /^sha256:[0-9a-f]{64}$/;
const profileId = /^[a-z][a-z0-9-]*$/;
const evidenceControlCharacters = /[\u0000-\u001f\u007f]/;
const snapshotMaxProfiles = 128;
const snapshotMaxEvidenceEntries = 32;
const snapshotMaxEvidenceLength = 300;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProfileCapabilitySnapshot(value: unknown): void {
  if (!record(value) || Object.keys(value).length > snapshotMaxProfiles) {
    throw new Error("invalid profile capability snapshot");
  }
  for (const [id, entry] of Object.entries(value)) {
    if (
      !profileId.test(id) ||
      !record(entry) ||
      canonicalJson(Object.keys(entry).sort()) !==
        canonicalJson(["available", "evidence"]) ||
      typeof entry.available !== "boolean" ||
      !Array.isArray(entry.evidence) ||
      entry.evidence.length > snapshotMaxEvidenceEntries ||
      entry.evidence.some(
        (item) =>
          typeof item !== "string" ||
          item.length === 0 ||
          item.length > snapshotMaxEvidenceLength ||
          evidenceControlCharacters.test(item),
      )
    ) {
      throw new Error("invalid profile capability snapshot");
    }
  }
}

export function validateResolvedRunConfig(value: unknown): ResolvedRunConfig {
  if (
    !record(value) || value.schemaVersion !== 1 || !record(value.runtime) ||
    !record(value.workflow) || !record(value.commands)
  ) {
    throw new Error("invalid resolved run configuration");
  }
  const topLevelKeys = canonicalJson(Object.keys(value).sort());
  if (
    topLevelKeys !==
      canonicalJson(["commands", "runtime", "schemaVersion", "workflow"]) &&
    topLevelKeys !==
      canonicalJson([
        "commands",
        "profileCapabilities",
        "runtime",
        "schemaVersion",
        "workflow",
      ])
  ) {
    throw new Error("resolved run configuration has unknown or missing fields");
  }
  if (value.profileCapabilities !== undefined) {
    validateProfileCapabilitySnapshot(value.profileCapabilities);
  }
  const runtime = value.runtime;
  if (
    canonicalJson(Object.keys(runtime).sort()) !==
      canonicalJson(["harnessVersion", "packageName", "packageRoot", "packageVersion", "runtimeHash", "transportHash"]) ||
    typeof runtime.harnessVersion !== "string" || runtime.harnessVersion.length === 0 ||
    runtime.packageName !== "pi-multi-agent-harness" ||
    typeof runtime.packageVersion !== "string" || runtime.packageVersion.length === 0 ||
    typeof runtime.packageRoot !== "string" || !isAbsolute(runtime.packageRoot) ||
    typeof runtime.transportHash !== "string" || !digest.test(runtime.transportHash) ||
    typeof runtime.runtimeHash !== "string" || !digest.test(runtime.runtimeHash)
  ) {
    throw new Error("invalid resolved runtime identity");
  }
  const workflow = value.workflow;
  if (
    typeof workflow.name !== "string" ||
    !Array.isArray(workflow.stages) ||
    !record(workflow.profiles) ||
    !record(workflow.profiles.byId) ||
    typeof workflow.profiles.hash !== "string" ||
    typeof workflow.resolvedProfilesHash !== "string" ||
    workflow.resolvedProfilesHash !== workflow.profiles.hash ||
    typeof workflow.revision !== "string" ||
    !digest.test(workflow.revision) ||
    !digest.test(workflow.resolvedProfilesHash)
  ) {
    throw new Error("invalid resolved workflow");
  }
  const { revision: _revision, ...revisionInput } = workflow;
  if (contentRevision(revisionInput) !== workflow.revision) {
    throw new Error("resolved workflow revision does not match its content");
  }
  for (const [name, argv] of Object.entries(value.commands)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !Array.isArray(argv) || argv.some((item) => typeof item !== "string")) {
      throw new Error("invalid resolved command");
    }
  }
  return deepFreeze(structuredClone(value)) as unknown as ResolvedRunConfig;
}

export async function readResolvedRunConfig(path: string): Promise<ResolvedRunConfig> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 * 1024) {
    throw new Error("resolved run configuration is not a bounded regular file");
  }
  return validateResolvedRunConfig(JSON.parse(await readFile(path, "utf8")));
}

export async function writeResolvedRunConfig(
  path: string,
  value: ResolvedRunConfig,
): Promise<ResolvedRunConfig> {
  const validated = validateResolvedRunConfig(value);
  try {
    const existing = await readResolvedRunConfig(path);
    if (canonicalJson(existing) !== canonicalJson(validated)) {
      throw new Error("existing resolved run configuration does not match");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${canonicalJson(validated)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return validated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readResolvedRunConfig(path);
    if (canonicalJson(existing) !== canonicalJson(validated)) {
      throw new Error("existing resolved run configuration does not match");
    }
    return existing;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
