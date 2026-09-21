import { afterEach, expect, it } from "vitest";
import type { WorkerResult } from "../../src/contracts/worker-result.js";
import { initialRunState, type RunState } from "../../src/core/state.js";
import type { ValidatedTaskGraph } from "../../src/core/task-graph.js";
import { WorktreeLifecycle } from "../../src/git/workspace-lifecycle.js";
import { NodeProcessRunner } from "../../src/git/process.js";
import { HerdrRuntime } from "../../src/runtime/herdr/runtime.js";
import { HerdrProductionWorkerRuntime } from "../../src/runtime/production/herdr-worker.js";
import { DurableRecordStore } from "../../src/runtime/production/records.js";
import { initializeProductionRun } from "../../src/runtime/production/run.js";
import { ensureInstalledHerdr } from "../../src/runtime/production/system.js";
import { GitWorkerAttemptPort } from "../../src/runtime/production/worker-attempts.js";
import { workerAdapters } from "../../src/runtime/workers/index.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import { createTempGitRepository } from "../support/git-fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

it.runIf(process.env.HARNESS_E2E_REAL === "1")(
  "runs Codex, Devin, and Claude through the installed Herdr transport",
  async () => {
    expect(process.env.HARNESS_E2E_DISPOSABLE).toBe("1");
    const task = {
      id: "T001",
      description: "Create the live worker marker",
      phase: "Build",
      labels: [] as string[],
      parallelEligible: true,
      dependsOn: [] as string[],
      acceptanceRefs: ["FR-001"],
      ownedPaths: ["src/live-worker.txt"],
    };
    const metadata = canonicalJson({
      schema: "harness/task-metadata/v1",
      tasks: [task],
    });
    const tasksText = [
      "# Feature Tasks",
      "",
      "## Phase 1: Build",
      "- [ ] T001 [P] Create the live worker marker | deps=[] | ac=[\"FR-001\"] | paths=[\"src/live-worker.txt\"]",
      "",
      "<!-- harness-task-metadata:v1",
      metadata,
      "-->",
    ].join("\n");
    const artifactPaths = {
      spec: "specs/live/spec.md",
      plan: "specs/live/plan.md",
      tasks: "specs/live/tasks.md",
      graph: "specs/live/task-graph.json",
    } as const;
    const repo = await createTempGitRepository("live herdr e2e", {
      [artifactPaths.spec]: "# Specification\n\n- FR-001: A committed marker identifies the worker.\n",
      [artifactPaths.plan]: "# Plan\n\nCreate one marker file and verify the worktree.\n",
      [artifactPaths.tasks]: tasksText,
      [artifactPaths.graph]: `${JSON.stringify({
        schema: "harness/task-graph/v1",
        tasksSemanticHash: `sha256:${"1".repeat(64)}`,
        tasks: [task],
      })}\n`,
    });
    cleanup.push(repo.cleanup);
    const initialized = await initializeProductionRun({
      root: repo.path,
      runId: "LIVE001",
      workflowRevision: `sha256:${"2".repeat(64)}`,
      approvedPreviewHash: `sha256:${"3".repeat(64)}`,
      artifactPaths,
      remote: "origin",
      baseBranch: "main",
    });
    const graph: ValidatedTaskGraph = {
      graph: {
        schema: "harness/task-graph/v1",
        tasksSemanticHash: `sha256:${"1".repeat(64)}`,
        tasks: [task],
      },
      byId: new Map([[task.id, task]]),
      order: [task.id],
      reachability: new Map([[task.id, new Set()]]),
    };
    const worktrees = await WorktreeLifecycle.open({
      repository: repo.repository,
      workspaceRoot: initialized.paths.workers,
    });
    const adapters = workerAdapters();
    const selectedWorkers = (process.env.HARNESS_E2E_WORKERS ?? "codex,devin,claude")
      .split(",")
      .filter((worker): worker is "codex" | "devin" | "claude" =>
        ["codex", "devin", "claude"].includes(worker));
    expect(selectedWorkers[0]).toBe("codex");
    expect(selectedWorkers.length).toBeGreaterThan(1);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined),
    );
    const capabilities = await Promise.all(
      [...adapters.values()].filter((adapter) => selectedWorkers.includes(adapter.kind)).map(async (adapter) => [
        adapter.kind,
        await adapter.probe({ cwd: repo.path, process: new NodeProcessRunner(), env: environment }),
      ] as const),
    );
    const unavailable = capabilities.filter(([, capability]) => !capability.available);
    expect(unavailable, JSON.stringify(unavailable)).toEqual([]);
    let state: RunState = initialRunState("LIVE001", initialized.manifest.workflowRevision);
    const attempts = new GitWorkerAttemptPort({
      manifest: initialized.manifest,
      repository: repo.repository,
      worktrees,
      records: new DurableRecordStore(initialized.paths.artifacts),
      graph: () => graph,
      readState: async () => state,
      taskVerification: [["git", "status", "--porcelain"]],
    });
    const client = await ensureInstalledHerdr();
    const runtime = new HerdrProductionWorkerRuntime({
      adapters,
      herdr: new HerdrRuntime(client),
      attempts,
      timeoutMs: 15 * 60_000,
    });
    cleanup.push(async () => {
      client.close();
      await worktrees.cleanupAll();
    });
    const activeAttempts: Array<Parameters<typeof runtime.abort>> = [];
    cleanup.push(async () => {
      for (const [prepared, intent] of activeAttempts.splice(0).reverse()) {
        await runtime.abort(prepared, intent).catch(() => undefined);
      }
    });

    const implementationIntent = {
      action: "worker.execute" as const,
      idempotencyKey: "worker.execute:implement:T001:1",
      recovery: "non_retryable" as const,
      laneKey: "job:implement:T001",
      input: {
        jobId: "implement:T001",
        stageId: "implement",
        taskId: "T001",
        attempt: 1,
        worker: "codex",
      },
    };
    const implementationPrepared = await runtime.prepare(implementationIntent);
    activeAttempts.push([implementationPrepared, implementationIntent]);
    const implementation = await runtime.execute(implementationPrepared, implementationIntent);
    expect(implementation).toMatchObject({ role: "implementation", outcome: "completed" });
    await runtime.afterCompleted(implementationPrepared, implementation, implementationIntent);
    activeAttempts.splice(activeAttempts.findIndex(([prepared]) => prepared === implementationPrepared), 1);
    state = structuredClone(state) as RunState;
    state.jobs["implement:T001"] = {
      state: "DONE",
      attempt: 1,
      worker: "codex",
      result: implementation,
    };

    const reviews: WorkerResult[] = [];
    for (const [index, worker] of selectedWorkers.slice(1).entries()) {
      const attempt = index + 1;
      const intent = {
        action: "worker.review" as const,
        idempotencyKey: `worker.review:review:T001:${attempt}`,
        recovery: "non_retryable" as const,
        laneKey: `job:review:T001:${attempt}`,
        input: {
          jobId: "review:T001",
          stageId: "review",
          taskId: "T001",
          attempt,
          worker,
        },
      };
      const prepared = await runtime.prepare(intent);
      activeAttempts.push([prepared, intent]);
      const result = await runtime.execute(prepared, intent);
      reviews.push(result);
      await runtime.afterCompleted(prepared, result, intent);
      activeAttempts.splice(activeAttempts.findIndex(([candidate]) => candidate === prepared), 1);
    }
    expect(reviews).toHaveLength(selectedWorkers.length - 1);
    reviews.forEach((result) => expect(result).toMatchObject({
      role: "review",
      outcome: "approved",
    }));
    expect(await repo.repository.revParse("refs/heads/harness/LIVE001-T001"))
      .toBe((implementation as { commit: string }).commit);
  },
  45 * 60_000,
);
