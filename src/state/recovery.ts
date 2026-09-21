import { copyFile, open, readFile, truncate } from "node:fs/promises";
import type { HarnessEvent } from "../contracts/events.js";
import { validateHarnessEvent } from "../contracts/events.js";
import { verifyHashChain, ZERO_HASH } from "./hash-chain.js";
import type { LeaseHandle } from "./lease.js";
import { readSnapshot, type SnapshotEnvelope } from "./snapshot.js";
import type { RunPaths } from "./types.js";

export interface RecoveryReport {
  readonly events: readonly HarnessEvent[];
  readonly repairedTail: boolean;
  readonly diagnosticPath?: string;
  readonly snapshot?: SnapshotEnvelope;
}

interface ParsedLines {
  readonly events: HarnessEvent[];
  readonly completeByteLength: number;
  readonly incompleteTail: boolean;
}

function parseCompleteJsonLines(bytes: Uint8Array): ParsedLines {
  const events: HarnessEvent[] = [];
  let start = 0;
  let completeByteLength = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    const lineBytes = bytes.slice(start, index);
    start = index + 1;
    completeByteLength = start;
    if (lineBytes.length === 0) {
      throw new Error(`interior corruption: empty JSONL record ${events.length + 1}`);
    }
    try {
      const line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
      events.push(validateHarnessEvent(JSON.parse(line)));
    } catch (error) {
      throw new Error(`interior corruption at record ${events.length + 1}`, {
        cause: error,
      });
    }
  }
  return {
    events,
    completeByteLength,
    incompleteTail: completeByteLength !== bytes.length,
  };
}

async function fsyncFile(path: string): Promise<void> {
  const file = await open(path, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

function acceptedSnapshot(
  snapshot: SnapshotEnvelope | undefined,
  events: readonly HarnessEvent[],
): SnapshotEnvelope | undefined {
  if (!snapshot) return undefined;
  if (snapshot.boundary.sequence === 0) {
    return snapshot.boundary.eventHash === ZERO_HASH ? snapshot : undefined;
  }
  const boundaryEvent = events[snapshot.boundary.sequence - 1];
  return boundaryEvent?.eventHash === snapshot.boundary.eventHash
    ? snapshot
    : undefined;
}

export async function recoverJournal(
  paths: RunPaths,
  lease: LeaseHandle,
): Promise<RecoveryReport> {
  await lease.assertCurrent();
  let bytes: Uint8Array;
  try {
    bytes = await readFile(paths.events);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") bytes = new Uint8Array();
    else throw error;
  }
  const parsed = parseCompleteJsonLines(bytes);
  try {
    verifyHashChain(parsed.events);
  } catch (error) {
    throw new Error("interior corruption in event hash chain", { cause: error });
  }

  let diagnosticPath: string | undefined;
  if (parsed.incompleteTail) {
    await lease.assertCurrent();
    diagnosticPath = `${paths.events}.diagnostic-${Date.now()}-${crypto.randomUUID()}`;
    await copyFile(paths.events, diagnosticPath);
    await lease.assertCurrent();
    await truncate(paths.events, parsed.completeByteLength);
    await fsyncFile(paths.events);
  }
  const snapshot = acceptedSnapshot(await readSnapshot(paths), parsed.events);
  return {
    events: parsed.events,
    repairedTail: parsed.incompleteTail,
    ...(diagnosticPath === undefined ? {} : { diagnosticPath }),
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}
