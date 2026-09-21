import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { EffectIntent } from "../../../src/actions/types.js";
import { DurableWorkerAction } from "../../../src/runtime/production/worker-action.js";
import { DurableRecordStore } from "../../../src/runtime/production/records.js";
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
  recovery: "non_retryable",
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
