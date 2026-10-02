import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { compileWorkflow } from "../../src/config/compile.js";
import type { TaskNode } from "../../src/contracts/task-graph.js";
import type { PiWorkerRuntime } from "../../src/runtime/pi-worker/runtime.js";
import { initializeProductionRun } from "../../src/runtime/production/run.js";
import { composeProductionRun } from "../../src/runtime/production/system.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import { semanticHash } from "../../src/speckit/semantic-hash.js";
import { createTempGitRepository } from "../support/git-fixtures.js";
import { fixtureResolvedProfiles } from "../support/factories.js";
import {
  PullRequestProcess,
  SimulatedPiRuntime,
} from "../support/simulated-runtime.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

function tasks(): readonly TaskNode[] {
  return [
    {
      id: "T001",
      description: "Implement one",
      phase: "Build",
      labels: [],
      parallelEligible: true,
      dependsOn: [],
      acceptanceRefs: ["FR-001"],
      ownedPaths: ["src/T001.txt"],
    },
    {
      id: "T002",
      description: "Implement two",
      phase: "Build",
      labels: [],
      parallelEligible: true,
      dependsOn: [],
      acceptanceRefs: ["FR-002"],
      ownedPaths: ["src/T002.txt"],
    },
    {
      id: "T003",
      description: "Integrate three",
      phase: "Integration",
      labels: [],
      parallelEligible: false,
      dependsOn: ["T001", "T002"],
      acceptanceRefs: ["SC-001"],
      ownedPaths: ["src/T003.txt"],
    },
  ];
}

function taskDocument(records: readonly TaskNode[]): string {
  const visible = [
    "# Feature Tasks",
    "",
    "## Phase 1: Build",
    "- [ ] T001 [P] Implement one | deps=[] | ac=[\"FR-001\"] | paths=[\"src/T001.txt\"]",
    "- [ ] T002 [P] Implement two | deps=[] | ac=[\"FR-002\"] | paths=[\"src/T002.txt\"]",
    "",
    "## Phase 2: Integration",
    "- [ ] T003 Integrate three | deps=[\"T001\",\"T002\"] | ac=[\"SC-001\"] | paths=[\"src/T003.txt\"]",
    "",
  ].join("\n");
  return `${visible}<!-- harness-task-metadata:v1\n${canonicalJson({
    schema: "harness/task-metadata/v1",
    tasks: records,
  })}\n-->`;
}

it("runs a durable diamond through real Git worktrees, verification, push, and PR", async () => {
  const repo = await createTempGitRepository("production e2e");
  const remote = await mkdtemp(join(tmpdir(), "pi-harness-remote-"));
  cleanup.push(async () => {
    await rm(remote, { recursive: true, force: true });
    await repo.cleanup();
  });
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["remote", "add", "origin", remote], { cwd: repo.path });

  const workflow = compileWorkflow({
    profiles: fixtureResolvedProfiles(),
    environment: {
      schema: "harness/environment/v1",
      commands: {
        task_verify: ["git", "status", "--porcelain"],
        full_verify: ["git", "status", "--porcelain"],
      },
      pi_packages: [],
    },
    workflow: {
      schema: "harness/v1",
      name: "owned-production-e2e",
      task_model: {
        source: "stages.tasks.outputs.graph",
        complete_when: { stage: "record_task_done" },
      },
      stages: [
        { id: "implement", uses: "worker.execute", runner: { prefer: ["implementer-devin", "implementer-codex", "implementer-claude"] }, foreach: { source: "stages.tasks.outputs.graph", key: "task.id" }, gate: "task.dependencies_done", isolation: "worktree", retry: { max_attempts: 3, max_elapsed_seconds: 3600 } },
        { id: "review", uses: "worker.review", runner: { prefer: ["reviewer-codex", "reviewer-claude", "reviewer-devin"] }, needs: [{ stage: "implement", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" }, policies: { require_different_profile_family: true, scope: "task" }, retry: { max_attempts: 3, max_elapsed_seconds: 3600 }, on_failure: { changes_requested: { retry_stage: "implement" } } },
        { id: "verify", uses: "command.run", needs: [{ stage: "review", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" }, with: { argv: "${commands.task_verify}" }, retry: { max_attempts: 3, max_elapsed_seconds: 3600 }, on_failure: { verification_failed: { retry_stage: "implement" } } },
        { id: "integrate", uses: "git.integrate", needs: [{ stage: "verify", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" } },
        { id: "post_integrate_verify", uses: "command.run", needs: [{ stage: "integrate", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" }, with: { argv: "${commands.task_verify}" }, retry: { max_attempts: 3, max_elapsed_seconds: 3600 }, on_failure: { verification_failed: { retry_stage: "implement" } } },
        { id: "record_task_done", uses: "git.project-task-status", needs: [{ stage: "post_integrate_verify", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" } },
        { id: "final_verify", uses: "command.run", needs: [{ stage: "record_task_done", scope: "all" }], with: { argv: "${commands.full_verify}" } },
        { id: "final_review", uses: "worker.review", runner: { prefer: ["reviewer-claude", "reviewer-codex", "reviewer-devin"] }, needs: [{ stage: "final_verify", scope: "all" }], policies: { scope: "final_diff" }, on_failure: { changes_requested: { block: "final_review_remediation_required" } } },
        { id: "push", uses: "git.push", needs: [{ stage: "final_review", scope: "all" }] },
        { id: "final_pr", uses: "github.pull-request", needs: [{ stage: "push", scope: "all" }] },
      ],
    },
  });
  const artifactPaths = {
    spec: "specs/feature/spec.md",
    plan: "specs/feature/plan.md",
    tasks: "specs/feature/tasks.md",
    graph: "specs/feature/task-graph.json",
  } as const;
  const initialized = await initializeProductionRun({
    root: repo.path,
    runId: "F300",
    workflowRevision: workflow.revision,
    approvedPreviewHash: `sha256:${"a".repeat(64)}`,
    artifactPaths,
    remote: "origin",
    baseBranch: "main",
  });

  const planningTree = await mkdtemp(join(tmpdir(), "pi-harness-planning-tree-"));
  await rm(planningTree, { recursive: true, force: true });
  await execa("git", ["worktree", "add", planningTree, "harness/plan-F300"], { cwd: repo.path });
  const records = tasks();
  const artifacts: Record<string, string> = {
    [artifactPaths.spec]: "# Specification\n\n- FR-001: One\n- FR-002: Two\n- SC-001: Three\n",
    [artifactPaths.plan]: "# Plan\n\nExecute the diamond.\n",
    [artifactPaths.tasks]: taskDocument(records),
    [artifactPaths.graph]: `${JSON.stringify({
      schema: "harness/task-graph/v1",
      tasksSemanticHash: semanticHash(records),
      tasks: records,
    })}\n`,
  };
  for (const [path, body] of Object.entries(artifacts)) {
    await mkdir(dirname(join(planningTree, path)), { recursive: true });
    await writeFile(join(planningTree, path), body, "utf8");
  }
  await execa("git", ["add", "."], { cwd: planningTree });
  await execa("git", ["commit", "-m", "docs: seal planning artifacts"], { cwd: planningTree });
  const planningCommit = (await execa("git", ["rev-parse", "HEAD"], { cwd: planningTree })).stdout;
  await execa("git", ["update-ref", initialized.manifest.runRef, planningCommit, initialized.manifest.frozenBase], { cwd: repo.path });
  await execa("git", ["worktree", "remove", planningTree], { cwd: repo.path });

  const piWorkers = new SimulatedPiRuntime();
  const process = new PullRequestProcess();
  const system = await composeProductionRun({
    initialized,
    workflow,
    artifactPaths,
    commands: {
      task_verify: ["git", "status", "--porcelain"],
      full_verify: ["git", "status", "--porcelain"],
    },
    pi: {} as any,
    context: {} as any,
    piWorkerRuntime: piWorkers as unknown as PiWorkerRuntime,
    process,
  });
  try {
    await system.controller.enqueue({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "start:F300",
      payload: { operation: "run" },
    });
    await system.drain();
    const state = await system.readState();
    const verificationEvents = (await readFile(initialized.paths.events, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line))
      .filter((event) => String(event.eventType).startsWith("verification."))
      .map((event) => ({ id: event.idempotencyKey, commit: event.payload.commit }));
    expect(
      state.jobs.final_pr?.state,
      JSON.stringify({ state, verificationEvents }, null, 2),
    ).toBe("DONE");
    expect(state.finalizedTasks).toEqual(expect.objectContaining({
      T001: expect.any(Object),
      T002: expect.any(Object),
      T003: expect.any(Object),
    }));
    expect(piWorkers.maxConcurrentImplementations).toBe(2);
    expect([...piWorkers.workerKinds].sort()).toEqual(["claude", "codex", "devin"]);
    expect(process.created).toBe(true);
    const runHead = await repo.repository.revParse(initialized.manifest.runRef);
    expect(process.head).toBe(runHead);
    const remoteHead = (await execa("git", ["ls-remote", "--refs", "origin", initialized.manifest.runRef], { cwd: repo.path })).stdout.split(/\s+/)[0];
    expect(remoteHead).toBe(runHead);
    const finalTasks = (await execa("git", ["show", `${runHead}:${artifactPaths.tasks}`], { cwd: repo.path })).stdout;
    expect(finalTasks.match(/- \[x\] T00[1-3]/g)).toHaveLength(3);
  } finally {
    await system.dispose();
  }
}, 30_000);
