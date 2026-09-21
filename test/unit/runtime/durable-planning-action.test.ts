import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DurablePlanningAction } from "../../../src/runtime/production/planning-action.js";
import { DurableRecordStore } from "../../../src/runtime/production/records.js";
import { actionContext, recoveryContext } from "../../support/state-fixtures.js";

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
