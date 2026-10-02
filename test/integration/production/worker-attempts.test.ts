import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initialRunState } from "../../../src/core/state.js";
import type { ValidatedTaskGraph } from "../../../src/core/task-graph.js";
import { WorktreeLifecycle } from "../../../src/git/workspace-lifecycle.js";
import { DurableRecordStore } from "../../../src/runtime/production/records.js";
import { GitWorkerAttemptPort } from "../../../src/runtime/production/worker-attempts.js";
import type { RunManifest } from "../../../src/state/run-manifest.js";
import { createTempGitRepository } from "../../support/git-fixtures.js";
import { sha256 } from "../../../src/shared/sha256.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";
import { execa } from "execa";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

it("binds an implementation attempt to Git, validates it, and persists its sealed change", async () => {
  const repo = await createTempGitRepository("production worker attempts");
  await mkdir(join(repo.path, "specs/feature"), { recursive: true });
  await writeFile(join(repo.path, "specs/feature/spec.md"),
    "# Specification\n\n- FR-001: Return a parsed value for valid input.\n");
  await execa("git", ["add", "specs/feature/spec.md"], { cwd: repo.path });
  await execa("git", ["commit", "-m", "test: add planning fixture"], { cwd: repo.path });
  const planningCommit = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo.path })).stdout;
  const worktreeRoot = join(repo.path, "..", `${repo.path.split("/").at(-1)}-attempts`);
  cleanup.push(async () => {
    await rm(worktreeRoot, { recursive: true, force: true });
    await repo.cleanup();
  });
  const run = await repo.repository.ensureRunBranch("F100", planningCommit);
  const worktrees = await WorktreeLifecycle.open({
    repository: repo.repository,
    workspaceRoot: worktreeRoot,
  });
  const task = {
    id: "T001",
    description: "Implement feature",
    phase: "build",
    labels: [] as string[],
    parallelEligible: true,
    dependsOn: [] as string[],
    acceptanceRefs: ["FR-001"],
    ownedPaths: ["src/**"],
  };
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
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId: "F100",
    workflowRevision: `sha256:${"2".repeat(64)}`,
    repositoryRoot: repo.path,
    repositoryIdentity: `sha256:${"3".repeat(64)}`,
    frozenBase: planningCommit,
    runRef: `refs/heads/${run.name}`,
    planningRef: "refs/heads/harness/plan-F100",
    artifactPaths: {
      spec: "specs/feature/spec.md",
      plan: "specs/feature/plan.md",
      tasks: "specs/feature/tasks.md",
      graph: "specs/feature/task-graph.json",
    },
    remote: "origin",
    baseBranch: "main",
    approvedPreviewHash: `sha256:${"4".repeat(64)}`,
    createdAt: "2026-09-21T00:00:00.000Z",
  };
  const records = new DurableRecordStore(join(repo.path, ".records"));
  const attempts = new GitWorkerAttemptPort({
    manifest,
    repository: repo.repository,
    worktrees,
    records,
    graph: () => graph,
    readState: async () => initialRunState("F100", manifest.workflowRevision),
    taskVerification: [],
    profiles: fixtureResolvedProfiles(),
    evidenceRoot: join(repo.path, ".preserved-evidence"),
  });
  const intent = {
    action: "worker.execute" as const,
    idempotencyKey: "worker.execute:implement:T001:1",
    recovery: "reconcilable" as const,
    laneKey: "job:implement:T001",
    input: {
      jobId: "implement:T001",
      stageId: "implement",
      taskId: "T001",
      attempt: 1,
      worker: "implementer-devin",
    },
  };
  const prepared = await attempts.prepare(intent);
  expect(prepared.assignment).toMatchObject({
    taskObjective: "Implement feature",
    acceptanceCriteria: ["FR-001: Return a parsed value for valid input."],
  });
  await mkdir(join(prepared.binding.path, "src"), { recursive: true });
  await writeFile(join(prepared.binding.path, "src/feature.ts"), "export const feature = true;\n");
  await execa("git", ["add", "src/feature.ts"], { cwd: prepared.binding.path });
  await execa("git", ["commit", "-m", "feat: implement fixture"], { cwd: prepared.binding.path });
  const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: prepared.binding.path })).stdout;
  await mkdir(join(prepared.binding.path, ".harness-output"), { recursive: true });
  const evidenceBody = JSON.stringify({ verified: true });
  await writeFile(join(prepared.binding.path, ".harness-output/result.json"), evidenceBody);
  const evidence = [
    "test-driven-development",
    "systematic-debugging",
    "verification-before-completion",
  ].map((name) => ({
    kind: `superpower:${name}`,
    path: ".harness-output/result.json",
    sha256: sha256(evidenceBody),
  }));
  await attempts.accept(prepared.assignment, {
    schemaVersion: 1,
    assignmentHash: prepared.assignment.assignmentHash,
    role: "implementation",
    outcome: "completed",
    commit: head,
    evidence,
  }, prepared.binding);

  await expect(records.get("sealed-change", "implement:T001")).resolves.toMatchObject({
    assignmentHash: prepared.assignment.assignmentHash,
    baseCommit: planningCommit,
    headCommit: head,
    changedPaths: ["src/feature.ts"],
  });
  await attempts.release(prepared.binding);
  expect(await readFile(join(repo.path, ".preserved-evidence", sha256(evidenceBody).slice(7)), "utf8"))
    .toBe(evidenceBody);
  await expect(attempts.release(prepared.binding)).resolves.toBeUndefined();
});
