import { expect, it, vi } from "vitest";
import type { EffectIntent, ReconcileResult } from "../../../src/actions/types.js";
import { createAssignment, type WorkerAssignment } from "../../../src/core/assignment.js";
import type { WorkerResult } from "../../../src/contracts/worker-result.js";
import type { LifecycleWorktreeBinding } from "../../../src/git/worktrees.js";
import {
  HerdrProductionWorkerRuntime,
  type ProductionHerdrPort,
} from "../../../src/runtime/production/herdr-worker.js";
import type { WorkerAdapter } from "../../../src/runtime/workers/types.js";

const commit = "a".repeat(40);
const binding = {
  id: "F001:implementation:T001:1",
  runId: "F001",
  taskId: "T001",
  attempt: 1,
  role: "implementation",
  path: "/tmp/F001/T001/1",
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
  recovery: "non_retryable",
  laneKey: "job:implement:T001",
  input: { jobId: "implement:T001", taskId: "T001", attempt: 1, worker: "devin" },
};

function fixture(recovery: ReconcileResult<any> = { status: "not_found" }) {
  const adapter = {
    kind: "devin",
    prepare: vi.fn(async () => ({
      assignment,
      prompt: "implement",
      resultPath: `${binding.path}/.harness-output/result.json`,
      metadata: {},
    })),
    launchSpec: vi.fn(() => ({
      kind: "devin",
      args: ["--sandbox", "Read .harness-output/assignment.md"],
      cwd: binding.path,
    })),
    cancelSpec: vi.fn(() => ({
      mode: "graceful_then_force",
      gracefulKeys: ["ctrl+c"],
      timeoutMs: 30_000,
      forcePane: true,
    })),
    collect: vi.fn(async () => ({ status: "valid", result })),
  } as unknown as WorkerAdapter;
  const reconcile = vi.fn<ProductionHerdrPort["reconcile"]>(async () => ({
    status: "not_found",
  }));
  const herdr = {
    ensureWorkspace: vi.fn(async () => ({
      workspaceId: "w1", paneId: "p1", worktreePath: binding.path, assignedCommit: commit,
    })),
    startAgent: vi.fn(async (started: any) => ({
      agentName: started.input.agentName,
      workerKind: "devin" as const,
      workspaceId: "w1", paneId: "p1", worktreePath: binding.path,
      assignedCommit: commit, status: "idle",
    })),
    submitAssignment: vi.fn(async () => ({
      acknowledged: true as const,
      assignmentHash: assignment.assignmentHash,
      reconciledByResult: false,
    })),
    waitForAgent: vi.fn(async () => undefined),
    readAgentTranscript: vi.fn(async () => "worker transcript"),
    stopAgent: vi.fn(async () => undefined),
    recoverSubmit: vi.fn(async () => recovery),
    reconcile,
    closeWorkspace: vi.fn(async () => undefined),
  };
  const attempts = {
    prepare: vi.fn(async () => ({ assignment, binding })),
    stagePrompt: vi.fn(async () => ".harness-output/assignment.md"),
    accept: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  return {
    adapter,
    herdr,
    attempts,
    runtime: new HerdrProductionWorkerRuntime({
      adapters: new Map([["devin", adapter]]),
      herdr,
      attempts,
    }),
  };
}

it("runs a prepared worker through Herdr and validates its durable result", async () => {
  const { runtime, herdr, attempts } = fixture();
  const prepared = await runtime.prepare(intent);
  await expect(runtime.execute(prepared, intent)).resolves.toEqual(result);
  expect(herdr.submitAssignment).toHaveBeenCalledOnce();
  expect(herdr.submitAssignment).toHaveBeenCalledWith(expect.objectContaining({
    input: expect.objectContaining({
      deliveredAtLaunch: true,
      deliveryMarker: "Read .harness-output/assignment.md",
    }),
  }));
  expect(attempts.stagePrompt).toHaveBeenCalledWith(binding, expect.stringContaining("implement"));
  expect(herdr.waitForAgent).not.toHaveBeenCalled();
  expect(attempts.accept).toHaveBeenCalledWith(assignment, result, binding);
  await runtime.afterCompleted(prepared, result, intent);
  expect(herdr.closeWorkspace).toHaveBeenCalledWith("w1");
  expect(attempts.release).toHaveBeenCalledWith(binding);
});

it.each(["blocked", "failed"] as const)(
  "quarantines an implementation attempt after a %s result",
  async (outcome) => {
    const { runtime, herdr, attempts } = fixture();
    const prepared = await runtime.prepare(intent);
    const terminalResult: WorkerResult = outcome === "blocked"
      ? {
          schemaVersion: 1,
          assignmentHash: assignment.assignmentHash,
          outcome,
          blocker: {
            reason: "cannot continue",
            evidence: [],
            suggestedChange: "retry elsewhere",
          },
        }
      : {
          schemaVersion: 1,
          assignmentHash: assignment.assignmentHash,
          outcome,
          reason: "cannot continue",
          evidence: [],
        };
    await runtime.afterCompleted(prepared, terminalResult, intent);
    expect(herdr.closeWorkspace).toHaveBeenCalledWith("w1");
    expect(attempts.abort).toHaveBeenCalledWith(binding);
    expect(attempts.release).not.toHaveBeenCalled();
  },
);

it("stops and releases an observed prepared attempt during abort", async () => {
  const { runtime, herdr, attempts } = fixture();
  const prepared = await runtime.prepare(intent);
  herdr.reconcile.mockResolvedValueOnce({
    status: "observed",
    output: {
      agentName: (prepared as any).identity.agentName,
      workerKind: "devin",
      workspaceId: "w1",
      paneId: "w1:p1",
      worktreePath: binding.path,
      assignedCommit: binding.commit,
      status: "blocked",
    },
  });
  await runtime.abort(prepared, intent);
  expect(herdr.stopAgent).toHaveBeenCalledOnce();
  expect(herdr.closeWorkspace).toHaveBeenCalledWith("w1");
  expect(attempts.abort).toHaveBeenCalledWith(binding);
});

it("reconciles a delivered prompt from the structured result without resubmission", async () => {
  const { runtime, herdr, attempts } = fixture({
    status: "observed",
    output: {
      acknowledged: true,
      assignmentHash: assignment.assignmentHash,
      reconciledByResult: true,
      result,
    },
  });
  const prepared = await runtime.prepare(intent);
  await expect(runtime.reconcile(prepared, intent)).resolves.toEqual({
    status: "observed",
    output: result,
  });
  expect(herdr.submitAssignment).not.toHaveBeenCalled();
  expect(attempts.accept).toHaveBeenCalledOnce();
});
