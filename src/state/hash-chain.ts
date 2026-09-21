import { readFile } from "node:fs/promises";
import type { HarnessEvent } from "../contracts/events.js";
import { validateHarnessEvent } from "../contracts/events.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { sha256 } from "../shared/sha256.js";

export const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;

export function eventHash(event: Omit<HarnessEvent, "eventHash">): `sha256:${string}` {
  return sha256(canonicalJson(event));
}

export function verifyHashChain(events: readonly HarnessEvent[]): void {
  let previousHash: string = ZERO_HASH;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      throw new Error(`hash chain sequence break at ${index + 1}`);
    }
    if (event.prevHash !== previousHash) {
      throw new Error(`hash chain previous hash mismatch at ${event.sequence}`);
    }
    const { eventHash: persistedHash, ...unsigned } = event;
    const computedHash = eventHash(unsigned as Omit<HarnessEvent, "eventHash">);
    if (persistedHash !== computedHash) {
      throw new Error(`hash chain event hash mismatch at ${event.sequence}`);
    }
    previousHash = event.eventHash;
  }
}

export async function readAndVerifyJournal(path: string): Promise<HarnessEvent[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (contents.length === 0) return [];
  if (!contents.endsWith("\n")) {
    throw new Error("hash chain has an incomplete trailing record");
  }
  const events = contents
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      try {
        return validateHarnessEvent(JSON.parse(line));
      } catch (error) {
        throw new Error(`hash chain malformed record ${index + 1}`, {
          cause: error,
        });
      }
    });
  verifyHashChain(events);
  return events;
}
