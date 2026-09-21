import type { EffectIntent } from "../../actions/types.js";
import type { JsonValue } from "../../contracts/common.js";
import type { DurableRecordStore } from "./records.js";
import type {
  PiProcessObservation,
  PiProcessSupervisor,
} from "../pi-process/types.js";

interface CleanupFailureRecord {
  readonly schemaVersion: 1;
  readonly intent: EffectIntent<string, Readonly<Record<string, unknown>>>;
  readonly message: string;
}

interface AbortFailureRecord extends CleanupFailureRecord {
  readonly prepared: Readonly<Record<string, JsonValue>>;
}

function validateRecord(value: unknown): CleanupFailureRecord {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { message?: unknown }).message !== "string" ||
    typeof (value as { intent?: unknown }).intent !== "object" ||
    (value as { intent?: unknown }).intent === null
  ) {
    throw new Error("invalid durable cleanup failure record");
  }
  const intent = (value as { intent: Record<string, unknown> }).intent;
  if (
    typeof intent.action !== "string" ||
    typeof intent.idempotencyKey !== "string" ||
    typeof intent.recovery !== "string" ||
    typeof intent.laneKey !== "string" ||
    typeof intent.input !== "object" || intent.input === null || Array.isArray(intent.input)
  ) {
    throw new Error("invalid durable cleanup failure intent");
  }
  return value as CleanupFailureRecord;
}

export async function recoverCleanupFailures(
  records: DurableRecordStore,
  retry: (
    intent: EffectIntent<string, Readonly<Record<string, unknown>>>,
  ) => Promise<void>,
  retryAbort?: (
    prepared: Readonly<Record<string, JsonValue>>,
    intent: EffectIntent<string, Readonly<Record<string, unknown>>>,
  ) => Promise<void>,
): Promise<void> {
  const failures = [
    ...await records.list<unknown>("worker-cleanup-failure"),
    ...await records.list<unknown>("action-cleanup-failure"),
  ];
  for (const value of failures) await retry(validateRecord(value).intent);
  for (const value of await records.list<unknown>("worker-abort-failure")) {
    const record = validateRecord(value);
    if (
      typeof (value as { prepared?: unknown }).prepared !== "object" ||
      (value as { prepared?: unknown }).prepared === null ||
      Array.isArray((value as { prepared?: unknown }).prepared)
    ) {
      throw new Error("invalid durable abort cleanup record");
    }
    if (retryAbort === undefined) {
      throw new Error("worker abort cleanup recovery is unavailable");
    }
    await retryAbort(
      (value as unknown as AbortFailureRecord).prepared,
      record.intent,
    );
    await records.remove("worker-abort-failure", record.intent.idempotencyKey);
  }
}

export async function recoverPiProcesses(
  records: DurableRecordStore,
  supervisor: PiProcessSupervisor,
): Promise<readonly PiProcessObservation[]> {
  const observations: PiProcessObservation[] = [];
  for (const record of await records.listPiProcesses()) {
    observations.push(await supervisor.observe(record));
  }
  return observations;
}
