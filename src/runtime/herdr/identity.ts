import { canonicalJson } from "../../shared/canonical-json.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { sha256 } from "../../shared/sha256.js";
import type { WorkerKind } from "../../core/routing.js";

export interface AttemptIdentityInput {
  readonly runId: string;
  readonly jobId: string;
  readonly taskId?: string;
  readonly attempt: number;
  readonly workerKind: WorkerKind;
  readonly assignmentHash: string;
  readonly workspaceId: string;
  readonly paneId: string;
  readonly worktreePath: string;
  readonly assignedCommit: string;
}

export interface AttemptIdentity extends AttemptIdentityInput {
  readonly agentName: string;
  readonly generationHash: string;
}

function safeFragment(value: string, maximum: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximum)
    .replace(/-+$/g, "");
  return normalized === "" ? "job" : normalized;
}

export function createAttemptIdentity(input: AttemptIdentityInput): AttemptIdentity {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error("attempt generation must be a positive integer");
  }
  const body = structuredClone(input);
  const generationHash = sha256(canonicalJson(body));
  const digest = generationHash.slice("sha256:".length, "sha256:".length + 12);
  const agentName = [
    "h",
    safeFragment(input.runId, 12),
    safeFragment(input.jobId, 20),
    `a${input.attempt}`,
    digest,
  ]
    .join("-")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return deepFreeze({ ...body, agentName, generationHash });
}

export function identityMismatchEvidence(
  observed: {
    readonly name?: string | null;
    readonly agent?: string | null;
    readonly pane_id?: string;
    readonly workspace_id?: string;
  },
  expected: AttemptIdentity,
): readonly string[] {
  const evidence: string[] = [];
  if (observed.name !== expected.agentName) {
    evidence.push(`agent name mismatch: ${String(observed.name)}`);
  }
  if (observed.agent !== expected.workerKind) {
    evidence.push(`worker kind mismatch: ${String(observed.agent)}`);
  }
  if (observed.pane_id !== expected.paneId) {
    evidence.push(`pane mismatch: ${String(observed.pane_id)}`);
  }
  if (observed.workspace_id !== expected.workspaceId) {
    evidence.push(`workspace mismatch: ${String(observed.workspace_id)}`);
  }
  return evidence;
}

