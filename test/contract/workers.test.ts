import { join } from "node:path";
import {
  createAssignment,
  type WorkerAssignment,
} from "../../src/core/assignment.js";
import { buildWorkerPrompt } from "../../src/runtime/workers/prompt.js";
import { parseWorkerResult } from "../../src/runtime/workers/result.js";
import {
  superpowersProfile,
} from "../../src/runtime/workers/superpowers-profile.js";
import type {
  HerdrAgentSpec,
  NativeAgentSession,
  PreparedWorker,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerHandle,
  WorkerProbeContext,
} from "../../src/runtime/workers/types.js";
import { workerContract } from "./worker-contract.js";
import { completedResultText } from "../support/worker-fixtures.js";
import { assignmentFixture } from "../support/controller-fixtures.js";
import { expect, it } from "vitest";
import { CodexAdapter } from "../../src/runtime/workers/codex.js";
import { DevinAdapter } from "../../src/runtime/workers/devin.js";
import { ClaudeAdapter } from "../../src/runtime/workers/claude.js";

class FakeAdapter implements WorkerAdapter {
  public readonly kind = "codex" as const;

  public async probe(_context: WorkerProbeContext): Promise<WorkerCapabilities> {
    return {
      available: true,
      launch: true,
      nativeResume: true,
      cancellation: "graceful_then_force",
      sandbox: true,
      superpowers: true,
      evidence: [],
    };
  }

  public async prepare(assignment: WorkerAssignment): Promise<PreparedWorker> {
    return {
      assignment,
      prompt: buildWorkerPrompt(assignment, superpowersProfile(assignment)),
      resultPath: join(
        assignment.worktree.path,
        ".harness-output",
        "result.json",
      ),
      metadata: { workerKind: this.kind },
    };
  }

  public launchSpec(prepared: PreparedWorker): HerdrAgentSpec {
    return {
      kind: this.kind,
      args: ["--non-interactive"],
      cwd: prepared.assignment.worktree.path,
    };
  }

  public resumeSpec(prepared: PreparedWorker, session: NativeAgentSession) {
    if (session.source !== `herdr:${this.kind}` || session.agent !== this.kind) {
      throw new Error("session source does not match worker adapter");
    }
    if (session.assignmentHash !== prepared.assignment.assignmentHash) {
      throw new Error("session assignment hash mismatch");
    }
    if (session.attempt !== prepared.assignment.attempt) {
      throw new Error("session attempt generation mismatch");
    }
    return {
      status: "supported" as const,
      session,
      assignmentHash: prepared.assignment.assignmentHash,
      args: ["resume", session.value],
    };
  }

  public cancelSpec(_handle: WorkerHandle) {
    return {
      mode: "graceful_then_force" as const,
      gracefulKeys: ["ctrl+c"],
      timeoutMs: 30_000,
      forcePane: true,
    };
  }

  public async collect(prepared: PreparedWorker) {
    return this.parseResult(
      completedResultText(prepared.assignment),
      prepared.assignment,
    );
  }

  public parseResult(raw: string, assignment: WorkerAssignment) {
    return parseWorkerResult(raw, assignment);
  }
}

workerContract("shared fake adapter", () => new FakeAdapter());
workerContract("codex", () => new CodexAdapter());
workerContract("devin", () => new DevinAdapter());
workerContract("claude", () => new ClaudeAdapter());

it("launches Claude as a one-shot headless worker", async () => {
  const adapter = new ClaudeAdapter();
  const prepared = await adapter.prepare(createAssignment({
    ...assignmentFixture(),
    profileId: "implementer-claude",
    profileFamily: "claude",
    workerKind: "claude",
  }));
  expect(adapter.launchSpec(prepared).args).toContain("--print");
});

it("models final-diff review as a detached read-only assignment without a task", async () => {
  const base = assignmentFixture();
  const { taskId: _taskId, ...withoutTask } = base;
  const assignment = createAssignment({
    ...withoutTask,
    stageId: "final_review",
    jobId: "final_review:run",
    itemKey: "run:F023",
    role: "review",
    reviewScope: "final_diff",
    profileId: "reviewer-codex",
    profileFamily: "codex",
    workerKind: "codex",
    frozenBase: "base123",
    runHead: "head456",
    commit: "head456",
    allowedPaths: [],
    worktree: {
      role: "review",
      path: "/tmp/harness-final-review",
      branch: null,
      commit: "head456",
      writable: false,
    },
  });
  const prepared = await new FakeAdapter().prepare(assignment);
  expect(assignment).toMatchObject({ scope: "final_diff", frozenBase: "base123" });
  expect(prepared.prompt).toContain("Final diff base: base123");
  expect(prepared.prompt).toContain("no task ID");
  expect(prepared.prompt).toContain("HARNESS_REVIEW_RESULT_V1");
  expect(prepared.prompt).toContain("Do not write files");
  expect(prepared.prompt).not.toContain("Write exactly one schemaVersion 1 JSON result");
});
