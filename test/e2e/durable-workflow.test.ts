import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compileWorkflow } from "../../src/config/compile.js";
import type { DecisionEventDraft } from "../../src/contracts/events.js";
import { createWorkflowCommandDeriver } from "../../src/core/workflow-engine.js";
import { validateGraph } from "../../src/core/task-graph.js";
import { createHarnessSystem } from "../../src/durable-composition-root.js";
import { Journal } from "../../src/state/journal.js";
import { RunLease } from "../../src/state/lease.js";
import type { RunPaths } from "../../src/state/types.js";
import { FakeClock } from "../support/fake-clock.js";
import {
  diamondTaskGraph,
  fixtureGraphContextFor,
} from "../support/factories.js";

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

it("runs a durable task DAG to quiescence and resumes scheduling after every observation", async () => {
  const graphDocument = diamondTaskGraph();
  const graph = validateGraph(
    graphDocument,
    fixtureGraphContextFor(graphDocument),
  );
  const workflow = compileWorkflow({
    environment: {
      schema: "harness/environment/v1",
      commands: { verify: ["npm", "test"] },
      pi_packages: [],
    },
    workflow: {
      schema: "harness/v1",
      name: "durable-fixture",
      task_model: {
        source: "stages.tasks.outputs.graph",
        complete_when: { stage: "finalize" },
      },
      stages: [
        { id: "prepare", uses: "command.run", with: { argv: "${commands.verify}" } },
        {
          id: "implement",
          uses: "worker.execute",
          runner: { prefer: ["devin", "codex", "claude"] },
          needs: [{ stage: "prepare", scope: "all" }],
          foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
          gate: "task.dependencies_done",
        },
        {
          id: "finalize",
          uses: "git.project-task-status",
          needs: [{ stage: "implement", scope: "same-item" }],
          foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
        },
        {
          id: "finish",
          uses: "command.run",
          needs: [{ stage: "finalize", scope: "all" }],
          with: { argv: "${commands.verify}" },
        },
      ],
    },
  });
  const root = await mkdtemp(join(tmpdir(), "durable-workflow-"));
  temporary.push(root);
  const paths = runPaths(root);
  const lease = await RunLease.acquire(paths, "controller:workflow");
  let activeImplementations = 0;
  let maxConcurrentImplementations = 0;
  const actionOrder: string[] = [];

  const system = createHarnessSystem({
    runId: "F025",
    workflowRevision: workflow.revision,
    journal: new Journal(paths),
    lease,
    clock: new FakeClock(),
    derive: createWorkflowCommandDeriver({ workflow, graph }),
    effects: {
      async runFresh(intent) {
        const input = intent.input as { stageId: string; taskId?: string };
        actionOrder.push(`${input.stageId}:${input.taskId ?? "run"}`);
        if (input.stageId === "implement") {
          activeImplementations += 1;
          maxConcurrentImplementations = Math.max(
            maxConcurrentImplementations,
            activeImplementations,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          activeImplementations -= 1;
        }
        return { ok: true };
      },
      async recover() {
        return { ok: true };
      },
    },
    lifecycle: {
      observed(intent): readonly DecisionEventDraft[] {
        const input = intent.input as {
          jobId: string;
          stageId: string;
          taskId?: string;
        };
        if (input.stageId === "finalize") {
          return [
            {
              eventType: "task.finalized",
              entityId: input.jobId,
              idempotencyKey: `finalized:${input.taskId}`,
              payload: {
                taskId: input.taskId!,
                candidateCommit: `candidate:${input.taskId}`,
                targetCommit: `target:${input.taskId}`,
                tasksSemanticHash: graphDocument.tasksSemanticHash,
              },
            },
            {
              eventType: "job.done",
              entityId: input.jobId,
              idempotencyKey: `done:${input.jobId}`,
              payload: { requiresTaskFinalization: true },
            },
          ];
        }
        return [{
          eventType: "job.done",
          entityId: input.jobId,
          idempotencyKey: `done:${input.jobId}`,
          payload: { requiresTaskFinalization: false },
        }];
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
  await system.drain();

  const state = await system.readState();
  expect(
    Object.values(state.jobs).every((job) => job.state === "DONE"),
    JSON.stringify(state.jobs, null, 2),
  ).toBe(true);
  expect(Object.keys(state.finalizedTasks).sort()).toEqual(["T001", "T002", "T003"]);
  expect(maxConcurrentImplementations).toBe(2);
  expect(actionOrder.indexOf("implement:T003")).toBeGreaterThan(
    actionOrder.indexOf("finalize:T002"),
  );
  expect(actionOrder.at(-1)).toBe("finish:run");
  await system.dispose();
});
