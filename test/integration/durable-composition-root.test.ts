import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AcceptedCommandRecord } from "../../src/controller/command-source.js";
import type { RunState } from "../../src/core/state.js";
import { createHarnessSystem } from "../../src/durable-composition-root.js";
import { IndeterminateEffect } from "../../src/actions/executor.js";
import { createWorkflowLifecycle } from "../../src/core/workflow-lifecycle.js";
import { Journal } from "../../src/state/journal.js";
import { RunLease } from "../../src/state/lease.js";
import type { RunPaths } from "../../src/state/types.js";
import { FakeClock } from "../support/fake-clock.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runPaths(root: string): RunPaths {
  return {
    repository: root,
    commonDir: root,
    root,
    events: join(root, "events.jsonl"),
    state: join(root, "state.json"),
    lease: join(root, "lease.json"),
    lockDir: join(root, "controller.lock"),
    artifacts: join(root, "artifacts"),
    assignments: join(root, "assignments"),
    workers: join(root, "workers"),
    evidence: join(root, "evidence"),
    logs: join(root, "logs"),
  };
}

it("persists an intent before dispatch and feeds its observation through the queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-composition-"));
  temporary.push(root);
  const paths = runPaths(root);
  const lease = await RunLease.acquire(paths, "controller:test");
  const clock = new FakeClock();
  const executions: string[] = [];
  const derive = (_state: RunState, accepted: AcceptedCommandRecord) => ({
      events: [],
      effects: accepted.command.source === "operator" ? [
        {
          action: "fake.effect",
          idempotencyKey: "fake-effect:F023:1",
          recovery: "reconcilable" as const,
          laneKey: "fake:F023",
          input: { entityId: "run:F023", value: 42 },
        },
      ] : [],
    });
  const system = createHarnessSystem({
    runId: "F023",
    workflowRevision: `sha256:${"a".repeat(64)}`,
    journal: new Journal(paths),
    lease,
    clock,
    derive,
    effects: {
      async runFresh(intent) {
        const before = await new Journal(paths).read();
        expect(before.some((event) => event.eventType === "effect.intent")).toBe(true);
        executions.push(intent.idempotencyKey);
        return { accepted: true };
      },
      async recover() {
        throw new Error("not used");
      },
    },
  });

  await system.controller.enqueue({
    schemaVersion: 1,
    source: "operator",
    kind: "operator_intent",
    idempotencyKey: "run:F023",
    payload: { operation: "run" },
  });
  await system.drain();

  const events = await new Journal(paths).read();
  expect(executions).toEqual(["fake-effect:F023:1"]);
  expect(events.map((event) => event.eventType)).toEqual(
    expect.arrayContaining(["effect.intent", "effect.observed"]),
  );
  expect(Object.keys((await system.readState()).outstandingEffects)).toEqual([]);
  await system.dispose();
});

it("reconciles an outstanding intent on resident restart without fresh execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-composition-recover-"));
  temporary.push(root);
  const paths = runPaths(root);
  const lease = await RunLease.acquire(paths, "controller:test-recovery");
  const clock = new FakeClock();
  const journal = new Journal(paths);
  await journal.append(
    {
      schemaVersion: 1,
      timestamp: clock.now().toISOString(),
      runId: "F024",
      entityId: "run:F024",
      idempotencyKey: "intent:event",
      eventType: "effect.intent",
      payload: {
        action: "fake.effect",
        idempotencyKey: "fake-effect:F024:1",
        recovery: "reconcilable",
        laneKey: "fake:F024",
        input: { entityId: "run:F024" },
      },
    },
    lease,
  );
  let recovered = 0;
  const system = createHarnessSystem({
    runId: "F024",
    workflowRevision: `sha256:${"b".repeat(64)}`,
    journal,
    lease,
    clock,
    derive: () => ({ events: [], effects: [] }),
    effects: {
      async runFresh() {
        throw new Error("fresh execution is forbidden during recovery");
      },
      async recover() {
        recovered += 1;
        return { reconciled: true };
      },
    },
  });

  await system.recover();
  await system.drain();
  expect(recovered).toBe(1);
  expect(Object.keys((await system.readState()).outstandingEffects)).toEqual([]);
  await system.dispose();
});

it("keeps a successful effect outstanding when lifecycle evidence cannot be mapped", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-composition-lifecycle-"));
  temporary.push(root);
  const paths = runPaths(root);
  const lease = await RunLease.acquire(paths, "controller:test-lifecycle");
  const journal = new Journal(paths);
  let acceptLifecycle = false;
  const system = createHarnessSystem({
    runId: "F025",
    workflowRevision: `sha256:${"c".repeat(64)}`,
    journal,
    lease,
    clock: new FakeClock(),
    derive: (_state, accepted) => ({
      events: [],
      effects: accepted.command.source === "operator" ? [{
        action: "custom.unmapped",
        idempotencyKey: "custom.unmapped:F025:1",
        recovery: "reconcilable" as const,
        laneKey: "custom:F025",
        input: {
          entityId: "job:F025",
          jobId: "job:F025",
          stageId: "custom",
          worker: "system",
        },
      }] : [],
    }),
    effects: {
      async runFresh() {
        return { externallyCompleted: true };
      },
      async recover() {
        return { externallyCompleted: true };
      },
    },
    lifecycle: {
      observed(intent, output) {
        if (!acceptLifecycle) {
          return createWorkflowLifecycle().observed(intent, output);
        }
        return [];
      },
    },
  });

  await system.controller.enqueue({
    schemaVersion: 1,
    source: "operator",
    kind: "operator_intent",
    idempotencyKey: "run:F025",
    payload: { operation: "run" },
  });
  await expect(system.drain()).rejects.toThrow(/no lifecycle mapper/);
  const events = await journal.read();
  expect(events.some((event) => event.eventType === "effect.intent")).toBe(true);
  expect(events.some((event) => event.eventType === "effect.failed")).toBe(false);
  expect(Object.keys((await system.readState()).outstandingEffects)).toEqual([
    "custom.unmapped:F025:1",
  ]);
  acceptLifecycle = true;
  await system.recover();
  await system.drain();
  expect(Object.keys((await system.readState()).outstandingEffects)).toEqual([]);
  await system.dispose();
});

it("blocks an indeterminate recovery with its evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-composition-indeterminate-"));
  temporary.push(root);
  const paths = runPaths(root);
  const lease = await RunLease.acquire(paths, "controller:test-indeterminate");
  const clock = new FakeClock();
  const journal = new Journal(paths);
  const effect = {
    action: "worker.execute",
    idempotencyKey: "worker.execute:implement:T001:1",
    recovery: "non_retryable" as const,
    laneKey: "job:implement:T001",
    input: {
      entityId: "implement:T001",
      jobId: "implement:T001",
      stageId: "implement",
      taskId: "T001",
      worker: "devin",
    },
  };
  await journal.append({
    schemaVersion: 1,
    timestamp: clock.now().toISOString(),
    runId: "F026",
    entityId: "implement:T001",
    idempotencyKey: "intent:event",
    eventType: "effect.intent",
    payload: effect,
  }, lease);
  const system = createHarnessSystem({
    runId: "F026",
    workflowRevision: `sha256:${"d".repeat(64)}`,
    journal,
    lease,
    clock,
    derive: () => ({ events: [], effects: [] }),
    effects: {
      async runFresh() {
        throw new Error("not used");
      },
      async recover(intent) {
        throw new IndeterminateEffect(intent, ["worker session outcome is unknown"]);
      },
    },
    lifecycle: createWorkflowLifecycle(),
  });

  await system.recover();
  await system.drain();
  const state = await system.readState();
  expect(state.jobs["implement:T001"]?.state).toBe("BLOCKED");
  const blocked = (await journal.read()).find((event) => event.eventType === "job.blocked");
  expect(blocked?.payload).toMatchObject({
    evidence: ["worker session outcome is unknown"],
  });
  await system.dispose();
});
