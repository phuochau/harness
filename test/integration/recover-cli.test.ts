import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../src/cli/main.js";
import { initProject } from "../../src/cli/init.js";
import { compileWorkflow } from "../../src/config/compile.js";
import { loadEnvironment, loadWorkflow } from "../../src/config/load.js";
import { Journal } from "../../src/state/journal.js";
import { RunLease } from "../../src/state/lease.js";
import { initializeProductionRun } from "../../src/runtime/production/run.js";
import { createTempGitRepository } from "../support/git-fixtures.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

it("fails before creating run state when the project configuration is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-recover-cli-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  await expect(main(["recover", "F023", root])).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});

it("runs standalone recovery with scheduling disabled for an existing durable run", async () => {
  const repo = await createTempGitRepository("recover cli");
  cleanup.push(repo.cleanup);
  await initProject({
    root: repo.path,
    commands: { taskVerify: ["node", "--version"], fullVerify: ["node", "--version"] },
  });
  const { execa } = await import("execa");
  await execa("git", ["add", "."], { cwd: repo.path });
  await execa("git", ["commit", "-m", "chore: initialize harness"], { cwd: repo.path });
  const environment = await loadEnvironment(join(repo.path, ".harness/environment.yaml"));
  const workflow = compileWorkflow({
    workflow: await loadWorkflow(join(repo.path, ".harness/workflow.yaml")),
    environment,
  });
  const initialized = await initializeProductionRun({
    root: repo.path,
    runId: "F023",
    workflowRevision: workflow.revision,
    approvedPreviewHash: `sha256:${"a".repeat(64)}`,
    artifactPaths: {
      spec: "specs/feature/spec.md",
      plan: "specs/feature/plan.md",
      tasks: "specs/feature/tasks.md",
      graph: "specs/feature/task-graph.json",
    },
    remote: "origin",
    baseBranch: "main",
  });
  const lease = await RunLease.acquire(initialized.paths, "fixture");
  await new Journal(initialized.paths).append({
    schemaVersion: 1,
    timestamp: "2026-09-21T00:00:00.000Z",
    runId: "F023",
    entityId: "run:F023",
    idempotencyKey: "run:create",
    eventType: "run.created",
    payload: { workflowRevision: workflow.revision },
  }, lease);
  await lease.release();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  await expect(main(["recover", "F023", repo.path])).resolves.toBe(0);
  await expect(access(initialized.paths.state)).resolves.toBeUndefined();
});
