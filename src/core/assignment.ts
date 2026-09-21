import type { WorkerKind } from "./routing.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { sha256 } from "../shared/sha256.js";
import { DefaultProtectedPaths } from "./protected-paths.js";

export interface WorktreeBinding {
  readonly role: "implementation" | "review" | "verification" | "remediation";
  readonly path: string;
  readonly branch: string | null;
  readonly commit: string;
  readonly writable: boolean;
}

export interface AssignmentInput {
  readonly runId: string;
  readonly stageId: string;
  readonly jobId: string;
  readonly itemKey: string;
  readonly taskId?: string;
  readonly attempt: number;
  readonly role: "implementation" | "review";
  readonly workerKind: WorkerKind;
  readonly implementationWorkerKind?: WorkerKind;
  readonly commit: string;
  readonly allowedPaths: readonly string[];
  readonly requiredDisciplines: readonly string[];
  readonly verificationCommands: readonly (readonly string[])[];
  readonly planningArtifacts: readonly string[];
  readonly worktree: WorktreeBinding;
}

export interface WorkerAssignment extends AssignmentInput {
  readonly schemaVersion: 1;
  readonly protectedPaths: readonly string[];
  readonly assignmentHash: `sha256:${string}`;
}

export function createAssignment(input: AssignmentInput): WorkerAssignment {
  const body = {
    schemaVersion: 1 as const,
    ...structuredClone(input),
    protectedPaths: [...DefaultProtectedPaths],
  };
  return deepFreeze({
    ...body,
    assignmentHash: sha256(canonicalJson(body)),
  }) as WorkerAssignment;
}
