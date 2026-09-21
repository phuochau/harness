import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPiWorkerResult,
  parseTerminalWorkerResult,
} from "../../../src/runtime/pi-worker/results.js";
import { contractAssignment, completedResultText } from "../../support/worker-fixtures.js";
import { recoverInterruptedDevin } from "../../../src/runtime/pi-worker/runtime.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi worker result boundaries", () => {
  it("retries Devin when the provider session identity changed", () => {
    expect(recoverInterruptedDevin({
      piSessionId: "333",
      priorProviderSessionId: "dorian-tangerine",
      loadedProviderSessionId: "brook-fruit",
    })).toEqual({
      status: "retry",
      reason: "provider session identity changed",
    });
  });

  it("accepts a matching result only at a complete settled terminal boundary", () => {
    const assignment = contractAssignment({ workerKind: "codex" });
    expect(parseTerminalWorkerResult(completedResultText(assignment), assignment, {
      settled: true,
      acceptedStopReason: true,
      completeToolResults: true,
      finalAssistantText: completedResultText(assignment),
    })).toMatchObject({ status: "valid" });
  });

  it("rejects an otherwise valid result before settlement", () => {
    const assignment = contractAssignment({ workerKind: "codex" });
    expect(parseTerminalWorkerResult(completedResultText(assignment), assignment, {
      settled: false,
      acceptedStopReason: true,
      completeToolResults: true,
      finalAssistantText: completedResultText(assignment),
    })).toEqual({ status: "invalid", reason: "Pi process did not reach a valid terminal boundary" });
  });

  it("rejects a review result for a different candidate commit", () => {
    const assignment = contractAssignment({
      role: "review",
      workerKind: "codex",
      implementationWorkerKind: "devin",
      worktree: {
        role: "review",
        path: "/tmp/review",
        branch: null,
        commit: "abc123",
        writable: false,
      },
    });
    const raw = JSON.stringify({
      schemaVersion: 1,
      assignmentHash: assignment.assignmentHash,
      role: "review",
      outcome: "approved",
      reviewedCommit: "wrong",
      findings: [],
      evidence: [],
    });
    expect(parseTerminalWorkerResult(raw, assignment, {
      settled: true,
      acceptedStopReason: true,
      completeToolResults: true,
      finalAssistantText: raw,
    })).toEqual({ status: "invalid", reason: "reviewed commit does not match assignment" });
  });

  it("materializes bounded review evidence from a framed Pi assistant result", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-pi-result-"));
    temporary.push(root);
    const assignment = contractAssignment({
      role: "review",
      workerKind: "codex",
      implementationWorkerKind: "devin",
      worktree: {
        role: "review",
        path: root,
        branch: null,
        commit: "abc123",
        writable: false,
      },
    });
    const envelope = {
      result: {
        schemaVersion: 1,
        assignmentHash: assignment.assignmentHash,
        role: "review",
        outcome: "approved",
        reviewedCommit: assignment.commit,
        findings: [],
      },
      evidence: [{ kind: "superpower:requesting-code-review", content: "reviewed" }],
    };
    const parsed = await collectPiWorkerResult({
      assignment,
      resultPath: join(root, ".harness-output", "result.json"),
      terminal: {
        settled: true,
        acceptedStopReason: true,
        completeToolResults: true,
        finalAssistantText: `done\nHARNESS_REVIEW_RESULT_V1 ${JSON.stringify(envelope)}\nHARNESS_REVIEW_RESULT_END_V1`,
      },
    });
    expect(parsed).toMatchObject({ status: "valid", result: { outcome: "approved" } });
    expect(await readFile(join(root, ".harness-output", "pi-evidence-1.txt"), "utf8"))
      .toBe("reviewed");
  });

  it("rejects quoted or non-final review protocol blocks", async () => {
    const assignment = contractAssignment({
      role: "review",
      workerKind: "codex",
      implementationWorkerKind: "devin",
      worktree: {
        role: "review",
        path: "/tmp/review",
        branch: null,
        commit: "abc123",
        writable: false,
      },
    });
    const envelope = JSON.stringify({
      result: {
        schemaVersion: 1,
        assignmentHash: assignment.assignmentHash,
        role: "review",
        outcome: "approved",
        reviewedCommit: assignment.commit,
        findings: [],
      },
      evidence: [],
    });
    const terminal = {
      settled: true,
      acceptedStopReason: true,
      completeToolResults: true,
    };
    expect(parseTerminalWorkerResult(
      `  HARNESS_REVIEW_RESULT_V1 ${envelope}\nHARNESS_REVIEW_RESULT_END_V1`,
      assignment,
      terminal,
    ).status).toBe("invalid");
    expect(parseTerminalWorkerResult(
      `HARNESS_REVIEW_RESULT_V1 ${envelope}\nHARNESS_REVIEW_RESULT_END_V1\nmore output`,
      assignment,
      terminal,
    ).status).toBe("invalid");
  });

  it("refuses to materialize review evidence through an output symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-pi-result-"));
    const external = await mkdtemp(join(tmpdir(), "harness-pi-result-external-"));
    temporary.push(root, external);
    await symlink(external, join(root, ".harness-output"));
    const assignment = contractAssignment({
      role: "review",
      workerKind: "codex",
      implementationWorkerKind: "devin",
      worktree: {
        role: "review",
        path: root,
        branch: null,
        commit: "abc123",
        writable: false,
      },
    });
    const envelope = JSON.stringify({
      result: {
        schemaVersion: 1,
        assignmentHash: assignment.assignmentHash,
        role: "review",
        outcome: "approved",
        reviewedCommit: assignment.commit,
        findings: [],
      },
      evidence: [],
    });
    await expect(collectPiWorkerResult({
      assignment,
      resultPath: join(root, ".harness-output", "result.json"),
      terminal: {
        settled: true,
        acceptedStopReason: true,
        completeToolResults: true,
        finalAssistantText: `HARNESS_REVIEW_RESULT_V1 ${envelope}\nHARNESS_REVIEW_RESULT_END_V1`,
      },
    })).rejects.toThrow(/output directory/);
  });
});
