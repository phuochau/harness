import { expect, it } from "vitest";
import type { EffectIntent } from "../../../src/actions/types.js";
import { createAttemptIdentity } from "../../../src/runtime/herdr/identity.js";
import {
  HerdrRuntime,
  type SubmitAssignmentInput,
  type WorkerStartInput,
} from "../../../src/runtime/herdr/runtime.js";
import { completedResult } from "../../support/factories.js";
import {
  FakeHerdrClient,
  fakeRuntimeEvidence,
} from "../../support/herdr-fixtures.js";

const assignmentHash = `sha256:${"a".repeat(64)}` as const;

function identity(overrides: Partial<Parameters<typeof createAttemptIdentity>[0]> = {}) {
  return createAttemptIdentity({
    runId: "F023",
    jobId: "implement:T001",
    taskId: "T001",
    attempt: 1,
    workerKind: "codex",
    assignmentHash,
    workspaceId: "w1",
    paneId: "w1:p1",
    worktreePath: "/repo task worktree",
    assignedCommit: "abc123",
    ...overrides,
  });
}

function startIntent(
  overrides: Partial<WorkerStartInput> = {},
): EffectIntent<"worker.start", WorkerStartInput> {
  const attemptIdentity = identity();
  return {
    action: "worker.start",
    idempotencyKey: "worker:start:F023:T001:1",
    recovery: "reconcilable",
    laneKey: "worker:T001",
    input: {
      identity: attemptIdentity,
      agentName: attemptIdentity.agentName,
      workerKind: "codex",
      args: [],
      ...overrides,
    },
  };
}

function submitIntent(
  overrides: Partial<SubmitAssignmentInput> = {},
): EffectIntent<"worker.submit", SubmitAssignmentInput> {
  const attemptIdentity = identity();
  return {
    action: "worker.submit",
    idempotencyKey: "worker:submit:F023:T001:1",
    recovery: "non_retryable",
    laneKey: "worker:T001",
    input: {
      identity: attemptIdentity,
      agentName: attemptIdentity.agentName,
      prompt: "Implement the assigned task and write result.json",
      resultPath: "/repo task worktree/.harness-output/result.json",
      ...overrides,
    },
  };
}

function agentSnapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  const attemptIdentity = identity();
  return {
    name: attemptIdentity.agentName,
    agent: "codex",
    pane_id: "w1:p1",
    workspace_id: "w1",
    agent_status: "idle",
    ...overrides,
  };
}

it("builds a stable Herdr-safe name from the immutable attempt identity", () => {
  const first = identity();
  const same = identity();
  const retry = identity({ attempt: 2 });
  expect(first.agentName).toBe(same.agentName);
  expect(first.agentName).not.toBe(retry.agentName);
  expect(first.agentName).toMatch(/^[a-z0-9-]{1,64}$/);
});

it("reattaches by stable native identity instead of launching twice", async () => {
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot() });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  await expect(runtime.reconcile(startIntent())).resolves.toMatchObject({
    status: "observed",
    output: { paneId: "w1:p1", workspaceId: "w1" },
  });
  expect(client.calls("agent.start")).toHaveLength(0);
});

it("treats a same-name agent in another pane as an identity collision", async () => {
  const client = new FakeHerdrClient({
    existingAgent: agentSnapshot({ pane_id: "w1:p9" }),
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  await expect(runtime.reconcile(startIntent())).resolves.toMatchObject({
    status: "indeterminate",
    evidence: expect.arrayContaining([expect.stringMatching(/pane/)]),
  });
});

it("opens an agent only in the assigned available shell pane", async () => {
  const client = new FakeHerdrClient();
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  await expect(runtime.startAgent(startIntent())).resolves.toMatchObject({
    agentName: identity().agentName,
    paneId: "w1:p1",
  });
  expect(client.calls("pane.process_info")).toHaveLength(1);
  expect(client.calls("agent.start")).toHaveLength(1);
});

it("reuses only the workspace whose worktree and commit still match", async () => {
  const client = new FakeHerdrClient();
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  await expect(
    runtime.ensureWorkspace({
      worktreePath: "/repo task worktree",
      assignedCommit: "abc123",
      label: "F023 T001",
      expectedWorkspaceId: "w1",
      expectedPaneId: "w1:p1",
    }),
  ).resolves.toEqual({
    workspaceId: "w1",
    paneId: "w1:p1",
    worktreePath: "/repo task worktree",
    assignedCommit: "abc123",
  });
  const moved = new HerdrRuntime(
    client,
    fakeRuntimeEvidence({ commit: "different" }),
  );
  await expect(
    moved.ensureWorkspace({
      worktreePath: "/repo task worktree",
      assignedCommit: "abc123",
      label: "F023 T001",
    }),
  ).rejects.toThrow(/worktree commit mismatch/);
});

it("refuses launch when the persisted pane disappeared or is busy", async () => {
  const missing = new HerdrRuntime(
    new FakeHerdrClient({ missingPane: true }),
    fakeRuntimeEvidence(),
  );
  await expect(missing.startAgent(startIntent())).rejects.toThrow(/pane not found/);

  const busy = new HerdrRuntime(
    new FakeHerdrClient({ foregroundBusy: true }),
    fakeRuntimeEvidence(),
  );
  await expect(busy.startAgent(startIntent())).rejects.toThrow(/interactive shell/);
});

it("acknowledges a prompt without combining it with a lifecycle wait", async () => {
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot() });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  await expect(runtime.submitAssignment(submitIntent())).resolves.toMatchObject({
    acknowledged: true,
    assignmentHash,
  });
  expect(client.calls("agent.prompt")).toHaveLength(1);
  expect(client.calls("agent.wait")).toHaveLength(0);
});

it("does not resend an assignment after ambiguous prompt delivery", async () => {
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot() });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  await expect(runtime.recoverSubmit(submitIntent())).resolves.toMatchObject({
    status: "indeterminate",
  });
  expect(client.calls("agent.prompt")).toHaveLength(0);
});

it("reconciles ambiguous delivery only from a matching structured result", async () => {
  const result = completedResult();
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot(), result });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence({ result }));
  await expect(runtime.recoverSubmit(submitIntent())).resolves.toMatchObject({
    status: "observed",
    output: { assignmentHash },
  });
});

it("ignores out-of-order agent events and never treats status as completion", async () => {
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot() });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  client.emit({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done", revision: 9 },
  });
  client.emit({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working", revision: 8 },
  });
  expect(runtime.latestAgentObservation("w1:p1")).toMatchObject({
    status: "done",
    revision: 9,
    completionDecided: false,
  });
});

it("stops the old attempt and proves it released the pane", async () => {
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot() });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  const observed = await runtime.reconcile(startIntent());
  expect(observed.status).toBe("observed");
  if (observed.status !== "observed") throw new Error("expected observed handle");
  await expect(runtime.stopAgent(observed.output)).resolves.toBeUndefined();
  expect(client.calls("agent.send_keys")).toHaveLength(1);
  expect(client.calls("agent.list").at(-1)).toBeDefined();
});
