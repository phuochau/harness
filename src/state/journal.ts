import { mkdir, open } from "node:fs/promises";
import type { JsonValue } from "../contracts/common.js";
import type { HarnessEvent } from "../contracts/events.js";
import { validateHarnessEvent } from "../contracts/events.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { sha256 } from "../shared/sha256.js";
import type { LeaseHandle } from "./lease.js";
import { readAndVerifyJournal, ZERO_HASH } from "./hash-chain.js";
import type { RunPaths } from "./types.js";

export interface EventInput {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly runId: string;
  readonly entityId: string;
  readonly idempotencyKey: string;
  readonly eventType: HarnessEvent["eventType"];
  readonly payload: JsonValue;
}

export interface AppendResult {
  readonly event: HarnessEvent;
  readonly inserted: boolean;
}

export class IdempotencyCollision extends Error {}

async function appendAndFsync(path: string, line: string): Promise<void> {
  const file = await open(path, "a", 0o600);
  try {
    await file.writeFile(line, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export class Journal {
  public constructor(private readonly paths: RunPaths) {}

  public async read(): Promise<HarnessEvent[]> {
    return readAndVerifyJournal(this.paths.events);
  }

  public async append(
    input: EventInput,
    lease: LeaseHandle,
  ): Promise<AppendResult> {
    await lease.assertCurrent();
    const events = await this.read();
    const existing = events.find(
      (event) =>
        event.runId === input.runId &&
        event.eventType === input.eventType &&
        event.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      if (canonicalJson(existing.payload) !== canonicalJson(input.payload)) {
        throw new IdempotencyCollision(
          `idempotency collision for ${input.runId}\0${input.eventType}\0${input.idempotencyKey}`,
        );
      }
      return { event: existing, inserted: false };
    }
    const previous = events.at(-1);
    const unsigned = {
      ...input,
      sequence: (previous?.sequence ?? 0) + 1,
      fencingToken: lease.fencingToken,
      prevHash: previous?.eventHash ?? ZERO_HASH,
    };
    const event = validateHarnessEvent({
      ...unsigned,
      eventHash: sha256(canonicalJson(unsigned)),
    });
    await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
    await appendAndFsync(this.paths.events, `${JSON.stringify(event)}\n`);
    return { event, inserted: true };
  }
}
