import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonValue } from "../contracts/common.js";
import { canonicalJson } from "../shared/canonical-json.js";
import type { LeaseHandle } from "./lease.js";
import type { RunPaths } from "./types.js";

export interface EventBoundary {
  readonly sequence: number;
  readonly eventHash: `sha256:${string}`;
}

export interface SnapshotEnvelope {
  readonly schemaVersion: 1;
  readonly boundary: EventBoundary;
  readonly state: JsonValue;
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeSnapshot(
  paths: RunPaths,
  state: unknown,
  boundary: EventBoundary,
  lease: LeaseHandle,
): Promise<void> {
  const temporary = `${paths.state}.${process.pid}-${crypto.randomUUID()}.tmp`;
  await lease.assertCurrent();
  const normalizedState = JSON.parse(canonicalJson(state)) as JsonValue;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(
      `${JSON.stringify({ schemaVersion: 1, boundary, state: normalizedState })}\n`,
      "utf8",
    );
    await file.sync();
  } finally {
    await file.close();
  }
  await lease.assertCurrent();
  await rename(temporary, paths.state);
  await fsyncDirectory(dirname(paths.state));
}

export async function readSnapshot(
  paths: RunPaths,
): Promise<SnapshotEnvelope | undefined> {
  let text: string;
  try {
    text = await readFile(paths.state, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<SnapshotEnvelope>;
  if (
    parsed.schemaVersion !== 1 ||
    !parsed.boundary ||
    !Number.isInteger(parsed.boundary.sequence) ||
    parsed.boundary.sequence < 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(parsed.boundary.eventHash) ||
    parsed.state === undefined
  ) {
    throw new Error("invalid state snapshot");
  }
  return parsed as SnapshotEnvelope;
}
