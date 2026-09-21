import { expect, it } from "vitest";
import type { EffectIntent } from "../../../src/actions/types.js";
import { createAttemptIdentity } from "../../../src/runtime/herdr/identity.js";
import {
  HerdrRuntime,
  isDevinActiveScreen,
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
      timeoutMs: 60_000,
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
  expect(first.agentName).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
});

it("distinguishes Devin active thinking from an approval blocker", () => {
  expect(isDevinActiveScreen(
    "Thinking · 1m 18s\nGuide Devin while it works\n(autonomous)",
  )).toBe(true);
  expect(isDevinActiveScreen(
    "Thinking earlier\nWriting ./.harness-output/result.json\nApprove once",
  )).toBe(false);
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

it("accepts a stable working one-shot agent with a state sequence", async () => {
  const client = new FakeHerdrClient({
    launchedAgent: { agent_status: "working", state_change_seq: 1 },
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  await expect(runtime.startAgent(startIntent())).resolves.toMatchObject({
    agentName: identity().agentName,
    status: "working",
  });
});

it("accepts a fast headless worker result after the native process exits", async () => {
  const result = completedResult({ assignmentHash });
  const client = new FakeHerdrClient({ agentExitsDuringLaunch: true });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence({ result }));

  await expect(runtime.startAgent(startIntent())).resolves.toMatchObject({
    agentName: identity().agentName,
    status: "done",
  });
  await expect(runtime.submitAssignment(submitIntent({
    deliveredAtLaunch: true,
  }))).resolves.toMatchObject({
    reconciledByResult: true,
    result,
  });
});

it("closes the result race when a headless worker exits between observation reads", async () => {
  const result = completedResult({ assignmentHash });
  const client = new FakeHerdrClient();
  let reads = 0;
  const runtime = new HerdrRuntime(client, {
    ...fakeRuntimeEvidence(),
    readResult: async () => (++reads === 1 ? undefined : result),
  });

  await expect(runtime.submitAssignment(submitIntent({
    deliveredAtLaunch: true,
  }))).resolves.toMatchObject({
    reconciledByResult: true,
    result,
  });
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

it("keeps its private source workspace until the linked workspace group closes", async () => {
  const client = new FakeHerdrClient({ existingWorktreeWorkspace: false });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());

  await expect(
    runtime.ensureWorkspace({
      worktreePath: "/repo task worktree",
      assignedCommit: "abc123",
      label: "F023 T001",
    }),
  ).resolves.toEqual({
    workspaceId: "w1",
    paneId: "w1:p1",
    worktreePath: "/repo task worktree",
    assignedCommit: "abc123",
  });

  expect(client.calls("workspace.create")).toEqual([
    expect.objectContaining({
      params: expect.objectContaining({ cwd: "/repo", focus: false }),
    }),
  ]);
  expect(client.calls("worktree.open")).toEqual([
    expect.objectContaining({
      params: expect.objectContaining({
        path: "/repo task worktree",
        workspace_id: "w-source",
      }),
    }),
  ]);
  expect(client.calls("workspace.close")).toHaveLength(0);

  await runtime.closeWorkspace("w1");

  expect(client.calls("workspace.close").map((call) => call.params)).toEqual([
    { workspace_id: "w1", close_group: true },
  ]);
});

it("refuses launch when the persisted pane disappeared", async () => {
  const missing = new HerdrRuntime(
    new FakeHerdrClient({ missingPane: true }),
    fakeRuntimeEvidence(),
  );
  await expect(missing.startAgent(startIntent())).rejects.toThrow(/pane not found/);

});

it("accepts completion only from the durable structured result", async () => {
  const result = completedResult({ assignmentHash });
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot() });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence({ result }));
  await expect(runtime.submitAssignment(submitIntent())).resolves.toMatchObject({
    acknowledged: true,
    assignmentHash,
    reconciledByResult: true,
  });
  expect(client.calls("agent.prompt")).toHaveLength(1);
  expect(client.calls("agent.prompt")[0]?.params).toMatchObject({
    wait: { until: ["working", "blocked"], timeout_ms: 30_000 },
  });
  expect(client.calls("agent.wait")).toHaveLength(0);
});

it("does not send terminal input when the assignment was delivered at agent launch", async () => {
  const result = completedResult({ assignmentHash });
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot(), result });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence({ result }));

  await expect(runtime.submitAssignment(submitIntent({
    deliveredAtLaunch: true,
  }))).resolves.toMatchObject({ result });
  expect(client.calls("agent.prompt")).toHaveLength(0);
  expect(client.calls("agent.send_keys")).toHaveLength(0);
});

it("does not resend an assignment after ambiguous prompt delivery", async () => {
  const client = new FakeHerdrClient({ existingAgent: agentSnapshot() });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  await expect(runtime.recoverSubmit(submitIntent())).resolves.toMatchObject({
    status: "indeterminate",
  });
  expect(client.calls("agent.prompt")).toHaveLength(0);
});

it("never sends terminal input when an agent settles without a result", async () => {
  const client = new FakeHerdrClient({
    existingAgent: agentSnapshot(),
    agentStatuses: ["idle", "working", "done"],
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());

  await expect(runtime.submitAssignment(submitIntent())).rejects.toThrow(
    /structured result/,
  );
  expect(client.calls("agent.send_keys")).toHaveLength(0);
});

it("fails a completed headless worker promptly when its result is missing", async () => {
  const client = new FakeHerdrClient({
    existingAgent: agentSnapshot({ agent_status: "done" }),
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());

  await expect(runtime.submitAssignment(submitIntent({
    deliveredAtLaunch: true,
    deliveryMarker: "staged assignment",
    timeoutMs: 500,
  }))).rejects.toThrow(/settled without a structured result/);
  expect(client.calls("agent.send_keys")).toHaveLength(0);
});

it("accepts a matching structured review result from a settled read-only transcript", async () => {
  const result = {
    schemaVersion: 1 as const,
    assignmentHash,
    role: "review" as const,
    outcome: "approved" as const,
    reviewedCommit: "c".repeat(40),
    findings: [],
    evidence: [],
  };
  const client = new FakeHerdrClient({
    existingAgent: agentSnapshot(),
    agentStatuses: ["idle", "working", "done"],
    transcript: "HARNESS_REVIEW_RESULT_V1 {...}",
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence({ transcriptResult: result }));

  await expect(runtime.submitAssignment(submitIntent({
    resultTransport: "transcript",
  }))).resolves.toMatchObject({
    reconciledByResult: true,
    result,
  });
  expect(client.calls("agent.send_keys")).toHaveLength(0);
});

it("materializes a final review transcript when the agent exits between polls", async () => {
  const result = {
    schemaVersion: 1 as const,
    assignmentHash,
    role: "review" as const,
    outcome: "approved" as const,
    reviewedCommit: "c".repeat(40),
    findings: [],
    evidence: [],
  };
  const client = new FakeHerdrClient({
    existingAgent: agentSnapshot({ agent_status: "working" }),
    agentDisappearsAfterGets: 1,
    transcript: "HARNESS_REVIEW_RESULT_V1 {...}\nHARNESS_REVIEW_RESULT_END_V1",
    transcriptResult: result,
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence({ transcriptResult: result }));

  await expect(runtime.submitAssignment(submitIntent({
    deliveredAtLaunch: true,
    resultTransport: "transcript",
  }))).resolves.toMatchObject({
    reconciledByResult: true,
    result,
  });
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

it("does not materialize a transcript result while the pane still has a worker process", async () => {
  const result = {
    schemaVersion: 1 as const,
    assignmentHash,
    role: "review" as const,
    outcome: "approved" as const,
    reviewedCommit: "c".repeat(40),
    findings: [],
    evidence: [],
  };
  const client = new FakeHerdrClient({
    existingAgent: agentSnapshot({ agent_status: "working" }),
    foregroundBusy: true,
    transcript: "HARNESS_REVIEW_RESULT_V1 {...}\nHARNESS_REVIEW_RESULT_END_V1",
    transcriptResult: result,
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence({ transcriptResult: result }));
  await expect(runtime.recoverSubmit(submitIntent({
    resultTransport: "transcript",
  }))).resolves.toMatchObject({ status: "indeterminate" });
  expect(client.calls("agent.read")).toHaveLength(0);
});

it("accepts agent_not_running as successful graceful cancellation", async () => {
  const client = new FakeHerdrClient({
    existingAgent: agentSnapshot(),
    agentExitsDuringLaunch: true,
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  const observed = await runtime.reconcile(startIntent());
  if (observed.status !== "observed") throw new Error("expected observed handle");
  await expect(runtime.stopAgent(observed.output, {
    mode: "graceful_then_force",
    gracefulKeys: ["ctrl+c"],
    timeoutMs: 10,
    forcePane: true,
  })).resolves.toBeUndefined();
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
  await expect(runtime.stopAgent(observed.output, {
    mode: "graceful_then_force",
    gracefulKeys: ["ctrl+c"],
    timeoutMs: 30_000,
    forcePane: true,
  })).resolves.toBeUndefined();
  expect(client.calls("agent.send_keys")).toHaveLength(1);
  expect(client.calls("agent.list").at(-1)).toBeDefined();
});

it("force-closes a non-cooperative agent workspace after graceful cancellation", async () => {
  const client = new FakeHerdrClient({
    existingAgent: agentSnapshot(),
    keepAgentAfterCancel: true,
  });
  const runtime = new HerdrRuntime(client, fakeRuntimeEvidence());
  const observed = await runtime.reconcile(startIntent());
  if (observed.status !== "observed") throw new Error("expected observed handle");
  await expect(runtime.stopAgent(observed.output, {
    mode: "graceful_then_force",
    gracefulKeys: ["ctrl+c"],
    timeoutMs: 10,
    forcePane: true,
  })).resolves.toBeUndefined();
  expect(client.calls("workspace.close")).toContainEqual(expect.objectContaining({
    params: { workspace_id: "w1", close_group: true },
  }));
});
