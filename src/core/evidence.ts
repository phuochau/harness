import {
  validateWorkerResult,
  type WorkerResult,
} from "../contracts/worker-result.js";
import type { WorkerAssignment } from "./assignment.js";
import { isProtectedPath, matchesAllowedPath } from "./protected-paths.js";

export interface EvidenceGit {
  changedPaths(base: string, head: string): Promise<readonly string[]>;
  worktreeStatus(path: string): Promise<readonly string[]>;
  worktreeCommit(path: string): Promise<string>;
}

export type EvidenceDecision =
  | {
      readonly accepted: true;
      readonly role: "implementation";
      readonly baseCommit: string;
      readonly headCommit: string;
      readonly changedPaths: readonly string[];
    }
  | {
      readonly accepted: true;
      readonly role: "review";
      readonly reviewedCommit: string;
      readonly decision: "approved" | "changes_requested";
    };

function assertRequiredEvidence(
  assignment: WorkerAssignment,
  result: WorkerResult,
): void {
  if (!("evidence" in result)) {
    throw new Error("required evidence is missing");
  }
  const evidence = result.evidence.filter(
    (
      item,
    ): item is { kind: string; path: string; sha256: string } =>
      typeof item !== "string",
  );
  if (evidence.length !== result.evidence.length) {
    throw new Error("required evidence is missing");
  }
  const kinds = new Set(evidence.map((item) => item.kind));
  for (const discipline of assignment.requiredDisciplines) {
    if (!kinds.has(`superpower:${discipline}`)) {
      throw new Error(`required evidence missing for discipline ${discipline}`);
    }
  }
  for (const command of assignment.verificationCommands) {
    if (!kinds.has(`command:${command.join(" ")}`)) {
      throw new Error(`required evidence missing for command ${command.join(" ")}`);
    }
  }
}

export async function validateEvidence(
  assignment: WorkerAssignment,
  resultValue: unknown,
  git: EvidenceGit,
): Promise<EvidenceDecision> {
  const result = validateWorkerResult(resultValue);
  if (assignment.role === "implementation") {
    if (
      result.outcome !== "completed" ||
      !("role" in result) ||
      result.role !== "implementation"
    ) {
      throw new Error("implementation assignment requires a completed result");
    }
    const changedPaths = await git.changedPaths(assignment.commit, result.commit);
    const protectedEdit = changedPaths.find(isProtectedPath);
    if (protectedEdit) throw new Error(`protected path edited: ${protectedEdit}`);
    const outsideScope = changedPaths.find(
      (path) => !matchesAllowedPath(path, assignment.allowedPaths),
    );
    if (outsideScope) throw new Error(`path outside assignment scope: ${outsideScope}`);
    if (result.assignmentHash !== assignment.assignmentHash) {
      throw new Error("assignment hash mismatch");
    }
    assertRequiredEvidence(assignment, result);
    return {
      accepted: true,
      role: "implementation",
      baseCommit: assignment.commit,
      headCommit: result.commit,
      changedPaths,
    };
  }

  if (
    (result.outcome !== "approved" && result.outcome !== "changes_requested") ||
    !("role" in result) ||
    result.role !== "review"
  ) {
    throw new Error("review assignment requires a review result");
  }
  if (result.reviewedCommit !== assignment.commit) {
    throw new Error(
      `reviewed commit ${result.reviewedCommit} does not match ${assignment.commit}`,
    );
  }
  if (assignment.workerKind === assignment.implementationWorkerKind) {
    throw new Error("reviewer must be a different worker kind");
  }
  if (
    assignment.worktree.role !== "review" ||
    assignment.worktree.branch !== null ||
    assignment.worktree.writable
  ) {
    throw new Error("review requires a detached read-only worktree");
  }
  const [commit, status] = await Promise.all([
    git.worktreeCommit(assignment.worktree.path),
    git.worktreeStatus(assignment.worktree.path),
  ]);
  if (commit !== assignment.commit || status.length > 0) {
    throw new Error("review worktree changed or became dirty");
  }
  if (result.assignmentHash !== assignment.assignmentHash) {
    throw new Error("assignment hash mismatch");
  }
  assertRequiredEvidence(assignment, result);
  return {
    accepted: true,
    role: "review",
    reviewedCommit: result.reviewedCommit,
    decision: result.outcome,
  };
}
