import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { canonicalJson } from "../shared/canonical-json.js";
import { deepFreeze } from "../shared/deep-freeze.js";

export interface RunArtifactPaths {
  readonly spec: string;
  readonly plan: string;
  readonly tasks: string;
  readonly graph: string;
}

export interface RunManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workflowRevision: `sha256:${string}`;
  readonly repositoryRoot: string;
  readonly repositoryIdentity: `sha256:${string}`;
  readonly frozenBase: string;
  readonly runRef: string;
  readonly planningRef: string;
  readonly artifactPaths: RunArtifactPaths;
  readonly remote: string;
  readonly baseBranch: string;
  readonly approvedPreviewHash: `sha256:${string}`;
  readonly createdAt: string;
}

export class RunManifestMismatch extends Error {}

const hash = /^sha256:[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40,64}$/;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ref = /^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function safeRepositoryPath(path: string): boolean {
  return path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRunManifest(value: unknown): RunManifest {
  if (!record(value)) throw new Error("run manifest must be an object");
  const expected = [
    "approvedPreviewHash", "artifactPaths", "baseBranch", "createdAt",
    "frozenBase", "planningRef", "remote", "repositoryIdentity",
    "repositoryRoot", "runId", "runRef", "schemaVersion", "workflowRevision",
  ].sort();
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(expected)) {
    throw new Error("run manifest has unknown or missing fields");
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" || !runIdPattern.test(value.runId) ||
    typeof value.workflowRevision !== "string" || !hash.test(value.workflowRevision) ||
    typeof value.repositoryRoot !== "string" || !isAbsolute(value.repositoryRoot) ||
    typeof value.repositoryIdentity !== "string" || !hash.test(value.repositoryIdentity) ||
    typeof value.frozenBase !== "string" || !commit.test(value.frozenBase) ||
    typeof value.runRef !== "string" || !ref.test(value.runRef) ||
    typeof value.planningRef !== "string" || !ref.test(value.planningRef) ||
    typeof value.remote !== "string" || value.remote.length === 0 ||
    typeof value.baseBranch !== "string" || value.baseBranch.length === 0 ||
    typeof value.approvedPreviewHash !== "string" || !hash.test(value.approvedPreviewHash) ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    !record(value.artifactPaths)
  ) {
    throw new Error("invalid run manifest");
  }
  const paths = value.artifactPaths;
  if (
    canonicalJson(Object.keys(paths).sort()) !== canonicalJson(["graph", "plan", "spec", "tasks"]) ||
    Object.values(paths).some((path) => typeof path !== "string" || !safeRepositoryPath(path))
  ) {
    throw new Error("invalid run manifest artifact path");
  }
  return deepFreeze(structuredClone(value)) as unknown as RunManifest;
}

export async function readRunManifest(path: string): Promise<RunManifest> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) {
    throw new Error("run manifest is not a bounded regular file");
  }
  return validateRunManifest(JSON.parse(await readFile(path, "utf8")));
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeRunManifest(
  path: string,
  value: RunManifest,
): Promise<RunManifest> {
  const validated = validateRunManifest(value);
  try {
    const existing = await readRunManifest(path);
    if (canonicalJson(existing) !== canonicalJson(validated)) {
      throw new RunManifestMismatch("existing run manifest does not match approved run");
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
    await syncDirectory(path);
    return validated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readRunManifest(path);
    if (canonicalJson(existing) !== canonicalJson(validated)) {
      throw new RunManifestMismatch("existing run manifest does not match approved run");
    }
    return existing;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
