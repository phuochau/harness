import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EffectIntent } from "../../../src/actions/types.js";
import { EffectExecutor } from "../../../src/actions/executor.js";
import { ActionRegistry } from "../../../src/actions/registry.js";
import {
  DurableWorkerAction,
  DurableWorkerCancelAction,
} from "../../../src/runtime/production/worker-action.js";
import { DurableRecordStore } from "../../../src/runtime/production/records.js";
import { recoverCleanupFailures } from "../../../src/runtime/production/cleanup-recovery.js";
import { actionContext, recoveryContext } from "../../support/state-fixtures.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

const result = {
  schemaVersion: 1 as const,
  assignmentHash: `sha256:${"a".repeat(64)}` as const,
  role: "implementation" as const,
  outcome: "completed" as const,
  commit: "b".repeat(40),
  evidence: [],
};

const intent: EffectIntent<"worker.execute", Record<string, unknown>> = {
  action: "worker.execute",
  idempotencyKey: "worker.execute:implement:T001:1",
  recovery: "reconcilable",
  laneKey: "job:implement:T001",
  input: { jobId: "implement:T001", taskId: "T001", attempt: 1, worker: "devin" },
};

it("recovers an ambiguously submitted prompt from its structured result", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  let executions = 0;
  const action = new DurableWorkerAction("worker.execute", {
    records: new DurableRecordStore(root),
    runtime: {
      prepare: async () => ({ assignmentHash: result.assignmentHash, resultPath: "/tmp/result.json" }),
      execute: async () => {
        executions += 1;
        throw new Error("crash after prompt delivery");
      },
      reconcile: async () => ({ status: "observed", output: result }),
    },
  });
  await expect(action.execute(actionContext(), intent)).rejects.toThrow(/crash/);
  await expect(action.reconcile(recoveryContext(), intent)).resolves.toEqual({
    status: "observed",
    output: result,
  });
  expect(executions).toBe(1);
});

it("aborts and quarantines a prepared attempt when execution fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  const prepared = { assignmentHash: result.assignmentHash };
  const abort = vi.fn(async () => undefined);
  const action = new DurableWorkerAction("worker.execute", {
    records: new DurableRecordStore(root),
    runtime: {
      prepare: async () => prepared,
      execute: async () => { throw new Error("worker crashed"); },
      reconcile: async () => ({ status: "not_found" }),
      abort,
    },
  });

  await expect(action.execute(actionContext(), intent)).rejects.toThrow(/worker crashed/);
  expect(abort).toHaveBeenCalledWith(prepared, intent);
});

it("durably retries failed-attempt cleanup after an abort error", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  const records = new DurableRecordStore(root);
  const prepared = { assignmentHash: result.assignmentHash };
  let cleanupFails = true;
  const abort = vi.fn(async (_prepared?: unknown, _intent?: unknown) => {
    if (cleanupFails) throw new Error("quarantine unavailable");
  });
  const action = new DurableWorkerAction("worker.execute", {
    records,
    runtime: {
      prepare: async () => prepared,
      execute: async () => { throw new Error("worker crashed"); },
      reconcile: async () => ({ status: "not_found" }),
      abort,
    },
  });

  await expect(action.execute(actionContext(), intent)).rejects.toMatchObject({
    deferred: true,
    code: "WORKER_CLEANUP_DEFERRED",
  });
  await expect(records.get("worker-abort-failure", intent.idempotencyKey)).resolves
    .toMatchObject({ schemaVersion: 1, message: "quarantine unavailable", prepared });
  cleanupFails = false;
  await recoverCleanupFailures(
    records,
    async () => undefined,
    async (recordedPrepared, recordedIntent) => abort(recordedPrepared, recordedIntent),
  );
  await expect(records.get("worker-abort-failure", intent.idempotencyKey)).resolves.toBeUndefined();
  expect(abort).toHaveBeenCalledTimes(2);
});

it("never re-prepares or re-executes a completed worker attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  let prepares = 0;
  let executions = 0;
  const action = new DurableWorkerAction("worker.execute", {
    records: new DurableRecordStore(root),
    runtime: {
      prepare: async () => {
        prepares += 1;
        return { assignmentHash: result.assignmentHash };
      },
      execute: async () => {
        executions += 1;
        return result;
      },
      reconcile: async () => ({ status: "not_found" }),
    },
  });
  await expect(action.execute(actionContext(), intent)).resolves.toEqual(result);
  await expect(action.execute(actionContext(), intent)).resolves.toEqual(result);
  expect({ prepares, executions }).toEqual({ prepares: 1, executions: 1 });
});

it("persists completion before running idempotent workspace cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  const records = new DurableRecordStore(root);
  let cleanupCalls = 0;
  const action = new DurableWorkerAction("worker.execute", {
    records,
    runtime: {
      prepare: async () => ({ assignmentHash: result.assignmentHash }),
      execute: async () => result,
      reconcile: async () => ({ status: "not_found" }),
      afterCompleted: async (_prepared, completed, completedIntent) => {
        cleanupCalls += 1;
        expect(completed).toEqual(result);
        await expect(
          records.get("worker-completed", completedIntent.idempotencyKey),
        ).resolves.toEqual(result);
      },
    },
  });

  await expect(action.execute(actionContext(), intent)).resolves.toEqual(result);
  await expect(action.execute(actionContext(), intent)).resolves.toEqual(result);
  expect(cleanupCalls).toBe(2);
});

it("keeps a durable worker success outstanding until cleanup succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  const records = new DurableRecordStore(root);
  let cleanupFails = true;
  let cleanupCalls = 0;
  const action = new DurableWorkerAction("worker.execute", {
    records,
    runtime: {
      prepare: async () => ({ assignmentHash: result.assignmentHash }),
      execute: async () => result,
      reconcile: async () => ({ status: "not_found" }),
      afterCompleted: async () => {
        cleanupCalls += 1;
        if (cleanupFails) throw new Error("workspace close failed");
      },
    },
  });

  await expect(action.execute(actionContext(), intent)).rejects.toMatchObject({
    deferred: true,
  });
  await expect(records.get("worker-completed", intent.idempotencyKey)).resolves.toEqual(result);
  await expect(records.get("worker-cleanup-failure", intent.idempotencyKey)).resolves.toMatchObject({
    schemaVersion: 1,
    message: "workspace close failed",
  });
  cleanupFails = false;
  const registry = new ActionRegistry();
  registry.register(action);
  const { isRecovery: _isRecovery, ...dependencies } = recoveryContext();
  const executor = new EffectExecutor(registry, dependencies);
  await recoverCleanupFailures(records, (recordedIntent) =>
    executor.retryCleanup(recordedIntent));
  await expect(records.get("worker-cleanup-failure", intent.idempotencyKey)).resolves.toBeUndefined();
  expect(cleanupCalls).toBe(2);
});

it("preserves a prepared attempt while reporting indeterminate recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  const prepared = { assignmentHash: result.assignmentHash };
  const abort = vi.fn(async () => undefined);
  const action = new DurableWorkerAction("worker.execute", {
    records: new DurableRecordStore(root),
    runtime: {
      prepare: async () => prepared,
      execute: async () => result,
      reconcile: async () => ({
        status: "indeterminate",
        evidence: ["worker result is ambiguous"],
      }),
      abort,
    },
  });
  await action.execute(actionContext(), intent).catch(() => undefined);
  const freshRoot = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(freshRoot);
  const recovering = new DurableWorkerAction("worker.execute", {
    records: new DurableRecordStore(freshRoot),
    runtime: {
      prepare: async () => prepared,
      execute: async () => result,
      reconcile: async () => ({
        status: "indeterminate",
        evidence: ["worker result is ambiguous"],
      }),
      abort,
    },
  });
  await new DurableRecordStore(freshRoot).put("worker-prepared", intent.idempotencyKey, prepared);
  abort.mockClear();
  await expect(recovering.reconcile(recoveryContext(), intent)).resolves.toMatchObject({
    status: "indeterminate",
  });
  expect(abort).not.toHaveBeenCalled();
});

it("durably marks and aborts an in-flight worker cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  const records = new DurableRecordStore(root);
  const prepared = { assignmentHash: result.assignmentHash };
  await records.put("worker-prepared", intent.idempotencyKey, prepared);
  const abort = vi.fn(async () => undefined);
  const runtime = {
    prepare: async () => prepared,
    execute: async () => result,
    reconcile: async () => ({ status: "not_found" as const }),
    abort,
  };
  const cancellation = new DurableWorkerCancelAction({ records, runtime });
  const cancelIntent = {
    action: "worker.cancel" as const,
    idempotencyKey: `worker.cancel:${intent.idempotencyKey}:operator-1`,
    recovery: "reconcilable" as const,
    laneKey: `cancellation:${intent.laneKey}`,
    input: {
      jobId: "implement:T001",
      stageId: "implement",
      worker: "devin",
      originalIntent: intent,
    },
  };

  await expect(cancellation.execute(actionContext(), cancelIntent)).resolves.toEqual({
    cancelledIntentKey: intent.idempotencyKey,
  });
  expect(abort).toHaveBeenCalledWith(prepared, intent);

  const action = new DurableWorkerAction("worker.execute", { records, runtime });
  await expect(action.reconcile(recoveryContext(), intent)).rejects.toMatchObject({
    code: "WORKER_CANCELLED",
  });
  expect(abort).toHaveBeenCalledTimes(1);
});

it("serializes concurrent cancellation delivery for one worker attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  const records = new DurableRecordStore(root);
  const prepared = { assignmentHash: result.assignmentHash };
  await records.put("worker-prepared", intent.idempotencyKey, prepared);
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  const abort = vi.fn(async () => abortGate);
  const cancellation = new DurableWorkerCancelAction({
    records,
    runtime: {
      prepare: async () => prepared,
      execute: async () => result,
      reconcile: async () => ({ status: "not_found" as const }),
      abort,
    },
  });
  const cancelIntent = {
    action: "worker.cancel" as const,
    idempotencyKey: `worker.cancel:${intent.idempotencyKey}:operator-2`,
    recovery: "reconcilable" as const,
    laneKey: `cancellation:${intent.laneKey}`,
    input: { originalIntent: intent },
  };

  const first = cancellation.execute(actionContext(), cancelIntent);
  const second = cancellation.execute(actionContext(), cancelIntent);
  await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
  releaseAbort();
  await expect(Promise.all([first, second])).resolves.toEqual([
    { cancelledIntentKey: intent.idempotencyKey },
    { cancelledIntentKey: intent.idempotencyKey },
  ]);
  expect(abort).toHaveBeenCalledTimes(1);
});

it("keeps a cancellation outstanding and durably retries abort cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-action-"));
  temporary.push(root);
  const records = new DurableRecordStore(root);
  const prepared = { assignmentHash: result.assignmentHash };
  await records.put("worker-prepared", intent.idempotencyKey, prepared);
  let fails = true;
  const abort = vi.fn(async () => {
    if (fails) throw new Error("stop failed");
  });
  const cancellation = new DurableWorkerCancelAction({
    records,
    runtime: {
      prepare: async () => prepared,
      execute: async () => result,
      reconcile: async () => ({ status: "not_found" as const }),
      abort,
    },
  });
  const cancelIntent = {
    action: "worker.cancel" as const,
    idempotencyKey: `worker.cancel:${intent.idempotencyKey}:operator-3`,
    recovery: "reconcilable" as const,
    laneKey: `cancellation:${intent.laneKey}`,
    input: { originalIntent: intent },
  };
  await expect(cancellation.execute(actionContext(), cancelIntent)).rejects.toMatchObject({
    deferred: true,
  });
  await expect(records.get("worker-abort-failure", intent.idempotencyKey)).resolves
    .toMatchObject({ prepared, message: "stop failed" });
  fails = false;
  await expect(cancellation.reconcile(recoveryContext(), cancelIntent)).resolves.toMatchObject({
    status: "observed",
  });
  await expect(records.get("worker-abort-failure", intent.idempotencyKey)).resolves.toBeUndefined();
  await expect(records.get("worker-aborted", intent.idempotencyKey)).resolves.toBeDefined();
});
