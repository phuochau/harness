import type { EffectIntent } from "../actions/types.js";
import type { JsonValue } from "../contracts/common.js";
import type { DecisionEventDraft, HarnessEvent } from "../contracts/events.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { Journal, type EventInput } from "../state/journal.js";
import { RunLease, type LeaseHandle } from "../state/lease.js";
import { resolveRunPaths } from "../state/paths.js";
import { recoverJournal } from "../state/recovery.js";
import { writeSnapshot } from "../state/snapshot.js";
import type { RunPaths } from "../state/types.js";
import { replayRunEvents, type RunOperationOptions } from "../cli/status.js";
import type { RunState } from "../core/state.js";
import { readFile, rmdir } from "node:fs/promises";

export interface RecoveryDependencies {
  readonly ownerId: string;
  readonly effects: { recover(intent: EffectIntent<string, JsonValue>): Promise<JsonValue> };
  readonly lifecycle?: {
    observed(
      intent: EffectIntent<string, JsonValue>,
      output: unknown,
    ): readonly DecisionEventDraft[];
  };
  readonly commands?: {
    drain(input: {
      readonly paths: RunPaths;
      readonly journal: Journal;
      readonly lease: LeaseHandle;
      readonly state: RunState;
    }): Promise<void>;
  };
  readonly now?: () => Date;
}

export interface RecoverySummary {
  readonly runId: string;
  readonly repairedTail: boolean;
  readonly recoveredEffects: number;
  readonly failedEffects: number;
  readonly pendingCommands: number;
  readonly schedulingEnabled: false;
  readonly lastSequence: number;
}

function entityFor(intent: EffectIntent<string, JsonValue>, runId: string): string {
  if (typeof intent.input === "object" && intent.input !== null && !Array.isArray(intent.input)) {
    const input = intent.input as Record<string, JsonValue>;
    if (typeof input.entityId === "string") return input.entityId;
    if (typeof input.jobId === "string") return input.jobId;
  }
  return `run:${runId}`;
}

function safeEvidence(error: unknown): string[] {
  const message = error instanceof Error ? error.message : "unknown recovery failure";
  return [message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|password|secret|authorization)=\S+/gi, "$1=[REDACTED]")];
}

function eventInput(
  now: Date,
  runId: string,
  entityId: string,
  idempotencyKey: string,
  eventType: HarnessEvent["eventType"],
  payload: JsonValue,
): EventInput {
  return {
    schemaVersion: 1,
    timestamp: now.toISOString(),
    runId,
    entityId,
    idempotencyKey,
    eventType,
    payload,
  };
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

async function appendLifecycle(
  journal: Journal,
  lease: LeaseHandle,
  now: Date,
  runId: string,
  drafts: readonly DecisionEventDraft[],
): Promise<void> {
  for (const draft of drafts) {
    await journal.append(
      eventInput(
        now,
        runId,
        draft.entityId,
        draft.idempotencyKey,
        draft.eventType as HarnessEvent["eventType"],
        draft.payload,
      ),
      lease,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireRecoveryLease(
  paths: RunPaths,
  ownerId: string,
  now: Date,
): Promise<LeaseHandle> {
  try {
    return await RunLease.acquire(paths, ownerId);
  } catch (error) {
    if (!(error instanceof Error) || !/lease held/.test(error.message)) throw error;
  }
  let stale: { ownerId?: unknown; acquiredAt?: unknown };
  try {
    stale = JSON.parse(await readFile(paths.lease, "utf8")) as typeof stale;
  } catch {
    throw new Error(`run lease held at ${paths.lockDir}`);
  }
  const match = typeof stale.ownerId === "string"
    ? /^recover:(\d+):/.exec(stale.ownerId)
    : undefined;
  const acquired = typeof stale.acquiredAt === "string"
    ? Date.parse(stale.acquiredAt)
    : Number.NaN;
  if (
    match === undefined ||
    match === null ||
    !Number.isFinite(acquired) ||
    now.getTime() - acquired < 30_000 ||
    processIsAlive(Number(match[1]))
  ) {
    throw new Error(`run lease held at ${paths.lockDir}`);
  }
  await rmdir(paths.lockDir);
  return RunLease.acquire(paths, ownerId);
}

export async function recoverRun(
  run: RunOperationOptions,
  dependencies: RecoveryDependencies,
): Promise<RecoverySummary> {
  const paths = await resolveRunPaths(run.root, run.runId);
  const lease = await acquireRecoveryLease(
    paths,
    dependencies.ownerId,
    dependencies.now?.() ?? new Date(),
  );
  try {
    const recovered = await recoverJournal(paths, lease);
    let state = replayRunEvents(recovered.events, run.runId);
    const journal = new Journal(paths);
    await dependencies.commands?.drain({ paths, journal, lease, state });
    state = replayRunEvents(await journal.read(), run.runId);

    let recoveredEffects = 0;
    let failedEffects = 0;
    for (const intent of Object.values(state.outstandingEffects)) {
      const typedIntent = intent as EffectIntent<string, JsonValue>;
      const entityId = entityFor(typedIntent, run.runId);
      try {
        const output = await dependencies.effects.recover(typedIntent);
        // Persist lifecycle evidence first. If recovery dies before effect.observed,
        // the intent stays outstanding and these idempotent records are replayed.
        await appendLifecycle(
          journal,
          lease,
          dependencies.now?.() ?? new Date(),
          run.runId,
          dependencies.lifecycle?.observed(typedIntent, output) ?? [],
        );
        await journal.append(
          eventInput(
            dependencies.now?.() ?? new Date(),
            run.runId,
            entityId,
            `recovered:${intent.idempotencyKey}`,
            "effect.observed",
            {
              action: intent.action,
              intentKey: intent.idempotencyKey,
              output: jsonValue(output),
            },
          ),
          lease,
        );
        recoveredEffects += 1;
      } catch (error) {
        const evidence = safeEvidence(error);
        await journal.append(
          eventInput(
            dependencies.now?.() ?? new Date(),
            run.runId,
            entityId,
            `recovery-failed:${intent.idempotencyKey}`,
            "effect.failed",
            {
              action: intent.action,
              intentKey: intent.idempotencyKey,
              code: "RECOVERY_INDETERMINATE",
              evidence,
            },
          ),
          lease,
        );
        await journal.append(
          eventInput(
            dependencies.now?.() ?? new Date(),
            run.runId,
            entityId,
            `recovery-blocked:${intent.idempotencyKey}`,
            "job.blocked",
            {
              reason: `effect ${intent.idempotencyKey} could not be reconciled`,
              evidence,
              suggestedChange: "Inspect external state, then retry recovery or resolve manually.",
            },
          ),
          lease,
        );
        failedEffects += 1;
      }
    }

    const events = await journal.read();
    state = replayRunEvents(events, run.runId);
    const boundary = events.at(-1)!;
    await writeSnapshot(
      paths,
      state,
      {
        sequence: boundary.sequence,
        eventHash: boundary.eventHash as `sha256:${string}`,
      },
      lease,
    );
    return {
      runId: run.runId,
      repairedTail: recovered.repairedTail,
      recoveredEffects,
      failedEffects,
      pendingCommands: Object.keys(state.pendingCommands).length,
      schedulingEnabled: false,
      lastSequence: state.lastSequence,
    };
  } finally {
    await lease.release();
  }
}
