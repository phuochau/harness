import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EffectIntent } from "../../../src/actions/types.js";
import { createAssignment, type WorkerAssignment } from "../../../src/core/assignment.js";
import type { WorkerResult } from "../../../src/contracts/worker-result.js";
import type { LifecycleWorktreeBinding } from "../../../src/git/worktrees.js";
import type { PiProcessRecord } from "../../../src/runtime/pi-process/types.js";
import type { PiWorkerRuntime } from "../../../src/runtime/pi-worker/runtime.js";
import { ProductionPiWorkerRuntime } from "../../../src/runtime/production/pi-worker.js";
import { DurableRecordStore } from "../../../src/runtime/production/records.js";
import { sha256 } from "../../../src/shared/sha256.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";
import { processRecord } from "../../support/pi-process-fixtures.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const commit = "a".repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-production-pi-"));
  temporary.push(root);
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const binding = {
    id: "F001:implementation:T001:1",
    runId: "F001",
    taskId: "T001",
    attempt: 1,
    role: "implementation",
    path: worktree,
    branch: "harness/F001-T001",
    commit,
    baseCommit: commit,
    writable: true,
    ownedPaths: ["src/**"],
    artifactPaths: [],
  } as const satisfies LifecycleWorktreeBinding;
  const assignment: WorkerAssignment = createAssignment({
    runId: "F001",
    stageId: "implement",
    jobId: "implement:T001",
    itemKey: "T001",
    taskId: "T001",
    attempt: 1,
    role: "implementation",
    workerKind: "devin",
    commit,
    allowedPaths: ["src/**"],
    requiredDisciplines: [],
    verificationCommands: [],
    planningArtifacts: ["spec.md", "plan.md", "tasks.md"],
    worktree: binding,
  });
  const result: WorkerResult = {
    schemaVersion: 1,
    assignmentHash: assignment.assignmentHash,
    role: "implementation",
    outcome: "completed",
    commit: "b".repeat(40),
    evidence: [],
  };
  const intent: EffectIntent<"worker.execute", Record<string, unknown>> = {
    action: "worker.execute",
    idempotencyKey: "worker.execute:implement:T001:1",
    recovery: "reconcilable",
    laneKey: "job:implement:T001",
    input: {
      jobId: "implement:T001",
      taskId: "T001",
      attempt: 1,
      worker: "implementer-devin",
    },
  };
  const profile = fixtureResolvedProfiles().byId[assignment.profileId]!;
  const controlDir = join(
    root,
    "processes",
    sha256("F001:implement:T001:1").slice("sha256:".length),
  );
  const process = processRecord({
    attemptId: "F001:implement:T001:1",
    attemptToken: "token",
    executable: "/managed/bin/pi",
    cwd: worktree,
    sessionId: "session",
    sessionDir: join(root, "session"),
    eventsPath: join(controlDir, "events.jsonl"),
    stderrPath: join(controlDir, "stderr.log"),
    recordPath: join(controlDir, "process.json"),
    providerPath: join(controlDir, "provider.json"),
  });
  const prepared = {
    attemptId: process.attemptId,
    assignment,
    profile,
    prompt: "implement",
    resultPath: join(worktree, ".harness-output", "result.json"),
    launch: {
      attemptId: process.attemptId,
      attemptToken: process.attemptToken,
      executable: process.executable,
      argv: ["--mode", "json"],
      cwd: worktree,
      env: {},
      sessionId: process.sessionId,
      sessionDir: process.sessionDir,
    },
  };
  const pi = {
    prepare: vi.fn(async () => prepared),
    launch: vi.fn(async () => ({ attemptId: process.attemptId, process })),
    collect: vi.fn(async () => ({ status: "valid" as const, result })),
    recover: vi.fn(async () => ({
      status: "running" as const,
      handle: { attemptId: process.attemptId, process },
    })),
    observe: vi.fn(async () => ({ status: "running" as const, record: process })),
    cancel: vi.fn(async () => ({ attemptId: process.attemptId, signals: ["SIGINT"], exit: null })),
  };
  const attempts = {
    prepare: vi.fn(async () => ({ assignment, binding })),
    stagePrompt: vi.fn(async () => ".harness-output/assignment.md"),
    accept: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const records = new DurableRecordStore(join(root, "records"));
  return {
    assignment,
    binding,
    result,
    intent,
    process,
    pi,
    attempts,
    records,
    runtime: new ProductionPiWorkerRuntime({
      runtime: pi as unknown as PiWorkerRuntime,
      profiles: fixtureResolvedProfiles(),
      attempts,
      records,
      processRoot: join(root, "processes"),
    }),
  };
}

it("launches one durable Pi process and accepts its structured result", async () => {
  const value = await fixture();
  const prepared = await value.runtime.prepare(value.intent);
  await expect(value.runtime.execute(prepared, value.intent)).resolves.toEqual(value.result);
  expect(value.pi.launch).toHaveBeenCalledOnce();
  await expect(value.records.getPiProcess(value.process.attemptId)).resolves.toEqual(value.process);
  expect(value.attempts.accept).toHaveBeenCalledWith(
    value.assignment,
    value.result,
    value.binding,
  );
  await value.runtime.afterCompleted(prepared, value.result);
  expect(value.attempts.release).toHaveBeenCalledWith(value.binding);
});

it("reattaches to a durable process without a second launch", async () => {
  const value = await fixture();
  const prepared = await value.runtime.prepare(value.intent);
  await value.records.putPiProcess(value.process);
  await expect(value.runtime.reconcile(prepared, value.intent)).resolves.toEqual({
    status: "observed",
    output: value.result,
  });
  expect(value.pi.launch).not.toHaveBeenCalled();
  expect(value.pi.recover).toHaveBeenCalledOnce();
});

it("coalesces concurrent execute calls into one Pi process launch", async () => {
  const value = await fixture();
  const prepared = await value.runtime.prepare(value.intent);
  await Promise.all([
    value.runtime.execute(prepared, value.intent),
    value.runtime.execute(prepared, value.intent),
  ]);
  expect(value.pi.launch).toHaveBeenCalledOnce();
});

it("rejects a persisted attempt whose controller directory was redirected", async () => {
  const value = await fixture();
  const prepared = await value.runtime.prepare(value.intent) as any;
  prepared.launch.controlDir = join(value.binding.path, ".harness-output", "forged-control");
  await expect(value.runtime.execute(prepared, value.intent)).rejects.toThrow(
    "persisted Pi worker attempt identity mismatch",
  );
  expect(value.pi.launch).not.toHaveBeenCalled();
});

it("does not signal a process that has already completed during cancellation", async () => {
  const value = await fixture();
  const prepared = await value.runtime.prepare(value.intent);
  await value.records.putPiProcess(value.process);
  (value.pi.observe as any).mockResolvedValueOnce({
    status: "exited",
    exit: {
      exitCode: 0,
      signal: null,
      terminal: { settled: true, acceptedStopReason: true, completeToolResults: true },
    },
  });
  await value.runtime.abort(prepared, value.intent);
  expect(value.pi.cancel).not.toHaveBeenCalled();
  expect(value.attempts.abort).toHaveBeenCalledWith(value.binding);
});
