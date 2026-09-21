import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { status } from "../../src/cli/status.js";
import { explain } from "../../src/cli/explain.js";
import { recoverRun } from "../../src/controller/reconcile-run.js";
import type { JsonValue } from "../../src/contracts/common.js";
import { journalFixture } from "../support/state-fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it("recovers effects but does not schedule without Pi", async () => {
  const fixture = await journalFixture();
  cleanups.push(fixture.cleanup);
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:00.000Z",
      runId: "F023",
      entityId: "run:F023",
      idempotencyKey: "run:create",
      eventType: "run.created",
      payload: { workflowRevision: `sha256:${"a".repeat(64)}` },
    },
    fixture.lease,
  );
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:01.000Z",
      runId: "F023",
      entityId: "implement:T001",
      idempotencyKey: "effect:start:T001",
      eventType: "effect.intent",
      payload: {
        action: "worker.start",
        idempotencyKey: "effect:start:T001",
        recovery: "reconcilable",
        laneKey: "worker:T001",
        input: { entityId: "implement:T001" },
      },
    },
    fixture.lease,
  );
  await fixture.lease.release();
  const summary = await recoverRun(
    { root: fixture.paths.repository, runId: "F023" },
    {
      ownerId: "recover:test",
      effects: { recover: async () => ({ agent: "existing" } as JsonValue) },
      now: () => new Date("2026-09-21T00:00:02.000Z"),
    },
  );
  const events = await fixture.journal.read();
  expect(summary).toMatchObject({ schedulingEnabled: false, recoveredEffects: 1 });
  expect(events).toContainEqual(expect.objectContaining({ eventType: "effect.observed" }));
  expect(events).not.toContainEqual(expect.objectContaining({ eventType: "attempt.started" }));
});

it("materializes lifecycle evidence while reconciling an outstanding effect", async () => {
  const fixture = await journalFixture();
  cleanups.push(fixture.cleanup);
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:00.000Z",
      runId: "F023",
      entityId: "run:F023",
      idempotencyKey: "run:create",
      eventType: "run.created",
      payload: { workflowRevision: `sha256:${"a".repeat(64)}` },
    },
    fixture.lease,
  );
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:00.500Z",
      runId: "F023",
      entityId: "implement:T001",
      idempotencyKey: "ready:T001",
      eventType: "job.ready",
      payload: {},
    },
    fixture.lease,
  );
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:00.750Z",
      runId: "F023",
      entityId: "implement:T001",
      idempotencyKey: "attempt:T001:1",
      eventType: "attempt.started",
      payload: { attempt: 1, worker: "codex" },
    },
    fixture.lease,
  );
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:01.000Z",
      runId: "F023",
      entityId: "implement:T001",
      idempotencyKey: "effect:execute:T001",
      eventType: "effect.intent",
      payload: {
        action: "worker.execute",
        idempotencyKey: "effect:execute:T001",
        recovery: "reconcilable",
        laneKey: "worker:T001",
        input: {
          jobId: "implement:T001",
          stageId: "implement",
          taskId: "T001",
          worker: "codex",
        },
      },
    },
    fixture.lease,
  );
  await fixture.lease.release();
  await recoverRun(
    { root: fixture.paths.repository, runId: "F023" },
    {
      ownerId: "recover:test",
      effects: { recover: async () => ({ outcome: "completed" } as JsonValue) },
      lifecycle: {
        observed: (intent) => [{
          eventType: "job.done",
          entityId: "implement:T001",
          idempotencyKey: `done:${intent.idempotencyKey}`,
          payload: { requiresTaskFinalization: false },
        }],
      },
      now: () => new Date("2026-09-21T00:00:02.000Z"),
    },
  );
  expect((await fixture.journal.read()).map((event) => event.eventType)).toEqual(
    expect.arrayContaining(["job.done", "effect.observed"]),
  );
});

it("records an indeterminate non-retryable effect as a blocker", async () => {
  const fixture = await journalFixture();
  cleanups.push(fixture.cleanup);
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:00.000Z",
      runId: "F023",
      entityId: "run:F023",
      idempotencyKey: "run:create",
      eventType: "run.created",
      payload: { workflowRevision: `sha256:${"a".repeat(64)}` },
    },
    fixture.lease,
  );
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:01.000Z",
      runId: "F023",
      entityId: "integrate:T001",
      idempotencyKey: "effect:push:T001",
      eventType: "effect.intent",
      payload: {
        action: "git.push",
        idempotencyKey: "effect:push:T001",
        recovery: "non_retryable",
        laneKey: "run-mutation:F023",
        input: { entityId: "integrate:T001" },
      },
    },
    fixture.lease,
  );
  await fixture.lease.release();
  await recoverRun(
    { root: fixture.paths.repository, runId: "F023" },
    {
      ownerId: "recover:test",
      effects: { recover: async () => { throw new Error("ambiguous push"); } },
      now: () => new Date("2026-09-21T00:00:02.000Z"),
    },
  );
  expect((await fixture.journal.read()).map((event) => event.eventType)).toEqual(
    expect.arrayContaining(["effect.failed", "job.blocked"]),
  );
});

it("leaves a deferred approval effect outstanding during standalone recovery", async () => {
  const fixture = await journalFixture();
  cleanups.push(fixture.cleanup);
  await fixture.journal.append({
    schemaVersion: 1,
    timestamp: "2026-09-21T00:00:00.000Z",
    runId: "F023",
    entityId: "run:F023",
    idempotencyKey: "run:create",
    eventType: "run.created",
    payload: { workflowRevision: `sha256:${"a".repeat(64)}` },
  }, fixture.lease);
  await fixture.journal.append({
    schemaVersion: 1,
    timestamp: "2026-09-21T00:00:01.000Z",
    runId: "F023",
    entityId: "integrate:T001",
    idempotencyKey: "effect:approval:T001",
    eventType: "effect.intent",
    payload: {
      action: "approval.request",
      idempotencyKey: "effect:approval:T001",
      recovery: "reconcilable",
      laneKey: "approval:F023",
      input: { entityId: "integrate:T001" },
    },
  }, fixture.lease);
  await fixture.lease.release();

  const summary = await recoverRun(
    { root: fixture.paths.repository, runId: "F023" },
    {
      ownerId: "recover:test",
      effects: {
        recover: async () => {
          throw Object.assign(new Error("approval pending"), { deferred: true });
        },
      },
      now: () => new Date("2026-09-21T00:00:02.000Z"),
    },
  );
  const events = await fixture.journal.read();
  expect(summary).toMatchObject({ recoveredEffects: 0, failedEffects: 0 });
  expect(events).not.toContainEqual(expect.objectContaining({ eventType: "effect.failed" }));
  expect(events).not.toContainEqual(expect.objectContaining({ eventType: "job.blocked" }));
});

it("repairs a torn tail while keeping status and explain read-only", async () => {
  const fixture = await journalFixture();
  cleanups.push(fixture.cleanup);
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:00.000Z",
      runId: "F023",
      entityId: "run:F023",
      idempotencyKey: "run:create",
      eventType: "run.created",
      payload: { workflowRevision: `sha256:${"a".repeat(64)}` },
    },
    fixture.lease,
  );
  await fixture.lease.release();
  const before = await readFile(fixture.paths.events, "utf8");
  expect(await status({ root: fixture.paths.repository, runId: "F023" }))
    .toMatchObject({ runId: "F023", lastSequence: 1 });
  expect(await explain({ root: fixture.paths.repository, runId: "F023", target: "run:F023" }))
    .toHaveLength(1);
  expect(await readFile(fixture.paths.events, "utf8")).toBe(before);

  await appendFile(fixture.paths.events, '{"partial":', "utf8");
  const recovered = await recoverRun(
    { root: fixture.paths.repository, runId: "F023" },
    {
      ownerId: "recover:test",
      effects: { recover: async () => ({}) },
      now: () => new Date("2026-09-21T00:00:02.000Z"),
    },
  );
  expect(recovered.repairedTail).toBe(true);
});

it("takes over only a provably dead, aged recovery lease", async () => {
  const fixture = await journalFixture();
  cleanups.push(fixture.cleanup);
  await fixture.journal.append(
    {
      schemaVersion: 1,
      timestamp: "2026-09-21T00:00:00.000Z",
      runId: "F023",
      entityId: "run:F023",
      idempotencyKey: "run:create",
      eventType: "run.created",
      payload: { workflowRevision: `sha256:${"a".repeat(64)}` },
    },
    fixture.lease,
  );
  await fixture.lease.release();
  await mkdir(fixture.paths.lockDir);
  await writeFile(
    fixture.paths.lease,
    JSON.stringify({
      ownerId: "recover:999999:dead",
      fencingToken: 1,
      acquiredAt: "2026-09-20T00:00:00.000Z",
    }),
  );
  await expect(
    recoverRun(
      { root: fixture.paths.repository, runId: "F023" },
      {
        ownerId: "recover:test",
        effects: { recover: async () => ({}) },
        now: () => new Date("2026-09-21T00:00:00.000Z"),
      },
    ),
  ).resolves.toMatchObject({ schedulingEnabled: false });
});
