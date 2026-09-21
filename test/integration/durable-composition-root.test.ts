import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { JsonValue } from "../../src/contracts/common.js";
import type { DecisionEventDraft } from "../../src/contracts/events.js";
import type { AcceptedCommandRecord } from "../../src/controller/command-source.js";
import type { RunState } from "../../src/core/state.js";
import { createHarnessSystem } from "../../src/durable-composition-root.js";
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
  const derive = (_state: RunState, accepted: AcceptedCommandRecord) => {
    const payload = accepted.command.payload as Record<string, JsonValue>;
    if (accepted.command.kind === "effect_result") {
      const event: DecisionEventDraft = payload.status === "observed"
        ? {
            eventType: "effect.observed",
            entityId: String(payload.entityId),
            idempotencyKey: `observed:${String(payload.intentKey)}`,
            payload: {
              action: String(payload.action),
              intentKey: String(payload.intentKey),
              output: payload.output ?? null,
            },
          }
        : {
            eventType: "effect.failed",
            entityId: String(payload.entityId),
            idempotencyKey: `failed:${String(payload.intentKey)}`,
            payload: {
              action: String(payload.action),
              intentKey: String(payload.intentKey),
              code: String(payload.code),
              evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
            },
          };
      return { events: [event], effects: [] };
    }
    return {
      events: [],
      effects: [
        {
          action: "fake.effect",
          idempotencyKey: "fake-effect:F023:1",
          recovery: "reconcilable" as const,
          laneKey: "fake:F023",
          input: { entityId: "run:F023", value: 42 },
        },
      ],
    };
  };
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
    derive: (_state, accepted) => {
      const payload = accepted.command.payload as Record<string, JsonValue>;
      return accepted.command.kind === "effect_result"
        ? {
            events: [{
              eventType: "effect.observed",
              entityId: String(payload.entityId),
              idempotencyKey: `observed:${String(payload.intentKey)}`,
              payload: {
                action: String(payload.action),
                intentKey: String(payload.intentKey),
                output: payload.output ?? null,
              },
            }],
            effects: [],
          }
        : { events: [], effects: [] };
    },
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
