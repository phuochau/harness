import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PlanningRequest } from "../../../src/ports/planning.js";
import { DurablePlanningAction } from "../../../src/runtime/production/planning-action.js";
import { DurableRecordStore } from "../../../src/runtime/production/records.js";
import { actionContext, recoveryContext } from "../../support/state-fixtures.js";

const artifactPathsFixture = {
  spec: "specs/f/spec.md",
  plan: "specs/f/plan.md",
  tasks: "specs/f/tasks.md",
  graph: "specs/f/task-graph.json",
} as const;

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("persists a Pi planning receipt before waiting for correlated Spec Kit artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-planning-action-"));
  temporary.push(root);
  const enqueue = vi.fn(async () => ({
    correlationId: "F001-tasks-1",
    generation: 1,
    sessionFile: "/tmp/session.jsonl",
    requestEntryId: "entry-1",
  }));
  const observe = vi.fn(async () => ({
    status: "completed" as const,
    correlationId: "F001-tasks-1",
    artifacts: {
      files: {},
      hashes: { "specs/f/tasks.md": `sha256:${"a".repeat(64)}` },
      commit: "b".repeat(40),
    },
  }));
  const action = new DurablePlanningAction("spec-kit.tasks", {
    runId: "F001",
    root,
    artifactPaths: {
      spec: "specs/f/spec.md",
      plan: "specs/f/plan.md",
      tasks: "specs/f/tasks.md",
      graph: "specs/f/task-graph.json",
    },
    records: new DurableRecordStore(join(root, "records")),
    planning: { enqueue, observe },
    pollMs: 1,
  });
  const intent = {
    action: "spec-kit.tasks" as const,
    idempotencyKey: "spec-kit.tasks:tasks:1",
    recovery: "reconcilable" as const,
    laneKey: "planning:F001",
    input: { attempt: 1 },
  };
  await expect(action.execute(actionContext(), intent)).resolves.toMatchObject({
    stage: "tasks",
    correlationId: "F001-tasks-1",
    commit: "b".repeat(40),
  });
  await expect(action.reconcile(recoveryContext(), intent)).resolves.toMatchObject({
    status: "observed",
  });
  expect(enqueue).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledOnce();
  await expect(
    new DurableRecordStore(join(root, "records")).get(
      "planning-completed",
      intent.idempotencyKey,
    ),
  ).resolves.toMatchObject({ correlationId: "F001-tasks-1" });
});

it("dispatches quick planning with the frozen kind and brief on a durable receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-quick-action-"));
  temporary.push(root);
  const enqueue = vi.fn(async (request: PlanningRequest) => ({
    correlationId: request.correlationId,
    generation: 1,
    sessionFile: "/tmp/session.jsonl",
    requestEntryId: "entry-1",
  }));
  const observe = vi.fn(async () => ({
    status: "completed" as const,
    correlationId: "F001-quick-1",
    artifacts: {
      files: {},
      hashes: { "specs/f/tasks.md": `sha256:${"a".repeat(64)}` },
      commit: "b".repeat(40),
    },
  }));
  const action = new DurablePlanningAction("harness.quick-plan", {
    runId: "F001",
    root,
    artifactPaths: artifactPathsFixture,
    records: new DurableRecordStore(join(root, "records")),
    planning: { enqueue, observe },
    pollMs: 1,
  });
  const intent = {
    action: "harness.quick-plan" as const,
    idempotencyKey: "harness.quick-plan:quick_plan:1",
    recovery: "reconcilable" as const,
    laneKey: "planning:F001",
    input: { attempt: 1, kind: "bugfix", brief: "Fix the crash on empty input" },
  };
  const output = await action.execute(actionContext(), intent);
  expect(output).toMatchObject({
    stage: "quick",
    correlationId: "F001-quick-1",
    command: "/harness.quick-plan",
    commit: "b".repeat(40),
  });
  expect(enqueue).toHaveBeenCalledOnce();
  expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
    stage: "quick",
    command: "/harness.quick-plan",
    correlationId: "F001-quick-1",
    kind: "bugfix",
    brief: "Fix the crash on empty input",
  });
});

it.each([
  { input: { attempt: 1, brief: "Fix the crash" }, reason: /kind/ },
  { input: { attempt: 1, kind: "bugfix" }, reason: /brief/ },
  { input: { attempt: 1, kind: "large-feature", brief: "x" }, reason: /kind/ },
])("rejects a quick intent missing %o without dispatching a planner", async ({ input, reason }) => {
  const root = await mkdtemp(join(tmpdir(), "harness-quick-reject-"));
  temporary.push(root);
  const enqueue = vi.fn();
  const action = new DurablePlanningAction("harness.quick-plan", {
    runId: "F001",
    root,
    artifactPaths: artifactPathsFixture,
    records: new DurableRecordStore(join(root, "records")),
    planning: { enqueue, observe: vi.fn() },
    pollMs: 1,
  });
  await expect(
    action.execute(actionContext(), {
      action: "harness.quick-plan",
      idempotencyKey: "harness.quick-plan:quick_plan:1",
      recovery: "reconcilable",
      laneKey: "planning:F001",
      input,
    }),
  ).rejects.toThrow(reason);
  expect(enqueue).not.toHaveBeenCalled();
});

it("replays a persisted quick receipt without dispatching a second planner turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-quick-replay-"));
  temporary.push(root);
  const records = new DurableRecordStore(join(root, "records"));
  const observe = vi.fn(async () => ({
    status: "completed" as const,
    correlationId: "F001-quick-1",
    artifacts: {
      files: {},
      hashes: { "specs/f/tasks.md": `sha256:${"a".repeat(64)}` },
      commit: "b".repeat(40),
    },
  }));
  const options = {
    runId: "F001",
    root,
    artifactPaths: artifactPathsFixture,
    records,
    pollMs: 1,
  };
  const intent = {
    action: "harness.quick-plan" as const,
    idempotencyKey: "harness.quick-plan:quick_plan:1",
    recovery: "reconcilable" as const,
    laneKey: "planning:F001",
    input: { attempt: 1, kind: "bugfix", brief: "Fix the crash" },
  };
  const first = new DurablePlanningAction("harness.quick-plan", {
    ...options,
    planning: {
      enqueue: vi.fn(async (request: PlanningRequest) => ({
        correlationId: request.correlationId,
        generation: 1,
        sessionFile: "/tmp/session.jsonl",
        requestEntryId: "entry-1",
      })),
      observe,
    },
  });
  await expect(first.execute(actionContext(), intent)).resolves.toMatchObject({
    stage: "quick",
  });
  const second = new DurablePlanningAction("harness.quick-plan", {
    ...options,
    planning: {
      enqueue: vi.fn(async () => {
        throw new Error("a second planner turn must not be dispatched");
      }),
      observe,
    },
  });
  await expect(second.execute(actionContext(), intent)).resolves.toMatchObject({
    stage: "quick",
    commit: "b".repeat(40),
  });
  await expect(second.reconcile(recoveryContext(), intent)).resolves.toMatchObject({
    status: "observed",
  });
});

it("persists a prepared child receipt before spawning the planning process", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-planning-prepare-"));
  temporary.push(root);
  const records = new DurableRecordStore(join(root, "records"));
  const intent = {
    action: "spec-kit.specify" as const,
    idempotencyKey: "spec-kit.specify:specify:1",
    recovery: "reconcilable" as const,
    laneKey: "planning:F001",
    input: { attempt: 1 },
  };
  const prepared = {
    correlationId: "F001-specify-1",
    generation: 1,
    sessionFile: "/tmp/planning/events.jsonl",
    requestEntryId: "planning:F001-specify-1:1",
  };
  const prepare = vi.fn(async () => prepared);
  const launchPrepared = vi.fn(async (receipt: typeof prepared) => {
    await expect(records.get("planning-receipt", intent.idempotencyKey))
      .resolves.toEqual(prepared);
    return receipt;
  });
  const action = new DurablePlanningAction("spec-kit.specify", {
    runId: "F001",
    root,
    artifactPaths: {
      spec: "specs/f/spec.md",
      plan: "specs/f/plan.md",
      tasks: "specs/f/tasks.md",
      graph: "specs/f/task-graph.json",
    },
    records,
    planning: {
      prepare,
      launchPrepared,
      enqueue: vi.fn(async () => prepared),
      observe: vi.fn(async () => ({
        status: "completed" as const,
        correlationId: prepared.correlationId,
        artifacts: { files: {}, hashes: { "specs/f/spec.md": `sha256:${"a".repeat(64)}` } },
      })),
    },
    pollMs: 1,
  });

  await action.execute(actionContext(), intent);
  expect(prepare).toHaveBeenCalledOnce();
  expect(launchPrepared).toHaveBeenCalledOnce();
});
