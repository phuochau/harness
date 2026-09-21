import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { fixtureResolvedProfiles } from "../support/factories.js";
import type { ManagedPiRuntimeBundle } from "../../src/runtime/managed/factory.js";
import type { JsonValue } from "../../src/contracts/common.js";
import { writeResolvedRunConfig } from "../../src/state/resolved-run-config.js";

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
    profiles: fixtureResolvedProfiles(),
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
  await writeResolvedRunConfig(initialized.paths.resolvedConfig, {
    schemaVersion: 1,
    runtime: {
      harnessVersion: "0.1.0",
      packageName: "pi-multi-agent-harness",
      packageVersion: "0.1.0",
      packageRoot: process.cwd(),
      transportHash: `sha256:${"b".repeat(64)}`,
      runtimeHash: `sha256:${"c".repeat(64)}`,
    },
    workflow,
    commands: environment.commands,
  });
  const profilesPath = join(repo.path, ".harness/profiles.yaml");
  await writeFile(
    profilesPath,
    (await readFile(profilesPath, "utf8")).replaceAll("pi-shell-acp/gpt-5.5", "pi-shell-acp/future-model"),
    "utf8",
  );
  const lockPath = join(repo.path, ".harness/harness.lock");
  await writeFile(
    lockPath,
    (await readFile(lockPath, "utf8")).replace("harnessVersion: 0.1.0", "harnessVersion: 9.9.9"),
    "utf8",
  );
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
  await new Journal(initialized.paths).append({
    schemaVersion: 1,
    timestamp: "2026-09-21T00:00:01.000Z",
    runId: "F023",
    entityId: "verify:T001",
    idempotencyKey: "verify:T001:1",
    eventType: "effect.intent",
    payload: {
      action: "command.run",
      idempotencyKey: "verify:T001:1",
      recovery: "reconcilable",
      laneKey: "verify:T001",
      input: { jobId: "verify:T001", argv: ["node", "--version"] },
    },
  }, lease);
  await lease.release();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  const workerRuntime = {} as ManagedPiRuntimeBundle["workerRuntime"];
  const managed = {
    profiles: fixtureResolvedProfiles(),
    workerRuntime,
  } as ManagedPiRuntimeBundle;
  let receivedRuntime: unknown;
  await expect(main(["recover", "F023", repo.path], {
    createManagedRuntimeFromResolved: async (input) => {
      expect(input.profiles).toEqual(workflow.profiles);
      expect(input.runtimeVersion).toBe("0.1.0");
      expect(input.packageRoot).toBe(process.cwd());
      expect(input.expectedPackage).toEqual({
        name: "pi-multi-agent-harness",
        version: "0.1.0",
        transportHash: `sha256:${"b".repeat(64)}`,
        runtimeHash: `sha256:${"c".repeat(64)}`,
      });
      return managed;
    },
    createStandaloneEffects: async (input) => {
      receivedRuntime = input.managedPiRuntime;
      return {
        effects: {
          runFresh: async () => ({} as JsonValue),
          recover: async () => ({ recovered: true } as JsonValue),
        },
        dispose: async () => undefined,
      };
    },
  })).resolves.toBe(0);
  expect(receivedRuntime).toBe(managed);
  await expect(access(initialized.paths.state)).resolves.toBeUndefined();
});
