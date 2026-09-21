import type { WorkerKind } from "./routing.js";
import type { ProfileFamily } from "../contracts/profiles.js";
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
  readonly reviewScope?: "task" | "final_diff";
  readonly frozenBase?: string;
  readonly runHead?: string;
  readonly attempt: number;
  readonly role: "implementation" | "review";
  readonly profileId?: string;
  readonly profileFamily?: ProfileFamily;
  readonly workerKind: WorkerKind;
  readonly implementationProfileFamily?: ProfileFamily;
  readonly implementationWorkerKind?: WorkerKind;
  readonly commit: string;
  readonly allowedPaths: readonly string[];
  readonly requiredDisciplines: readonly string[];
  readonly verificationCommands: readonly (readonly string[])[];
  readonly planningArtifacts: readonly string[];
  readonly worktree: WorktreeBinding;
}

type WorkerAssignmentBase = Omit<
  AssignmentInput,
  "profileId" | "profileFamily" | "implementationProfileFamily"
> & {
  readonly profileId: string;
  readonly profileFamily: ProfileFamily;
  readonly implementationProfileFamily?: ProfileFamily;
  readonly schemaVersion: 1;
  readonly protectedPaths: readonly string[];
  readonly assignmentHash: `sha256:${string}`;
};

export type WorkerAssignment =
  | (WorkerAssignmentBase & {
      readonly role: "implementation";
      readonly scope: "task";
      readonly taskId: string;
    })
  | (WorkerAssignmentBase & {
      readonly role: "review";
      readonly scope: "task";
      readonly taskId: string;
      readonly reviewScope?: "task";
    })
  | (WorkerAssignmentBase & {
      readonly role: "review";
      readonly scope: "final_diff";
      readonly reviewScope: "final_diff";
      readonly taskId?: never;
      readonly frozenBase: string;
      readonly runHead: string;
    });

export function createAssignment(input: AssignmentInput): WorkerAssignment {
  const profileFamily = input.profileFamily ?? input.workerKind;
  if (profileFamily !== input.workerKind) {
    throw new Error("profile family does not match transitional worker kind");
  }
  const implementationProfileFamily =
    input.implementationProfileFamily ?? input.implementationWorkerKind;
  if (
    input.implementationProfileFamily !== undefined &&
    input.implementationWorkerKind !== undefined &&
    input.implementationProfileFamily !== input.implementationWorkerKind
  ) {
    throw new Error(
      "implementation profile family does not match transitional worker kind",
    );
  }
  const profileId =
    input.profileId ??
    `${input.role === "implementation" ? "implementer" : "reviewer"}-${profileFamily}`;
  const scope = input.role === "implementation"
    ? "task"
    : input.reviewScope ?? "task";
  if (input.role === "implementation") {
    if (input.reviewScope !== undefined) {
      throw new Error("implementation assignment cannot declare review scope");
    }
    if (
      !input.worktree.writable ||
      (input.worktree.role !== "implementation" &&
        input.worktree.role !== "remediation")
    ) {
      throw new Error("implementation assignment requires a writable implementation worktree");
    }
  } else if (
    input.worktree.role !== "review" ||
    input.worktree.branch !== null ||
    input.worktree.writable
  ) {
    throw new Error("review assignment requires a detached read-only worktree");
  }
  if (scope === "task" && (input.taskId === undefined || input.taskId === "")) {
    throw new Error("task assignment requires taskId");
  }
  if (scope === "final_diff") {
    if (input.taskId !== undefined) {
      throw new Error("final-diff review must not carry taskId");
    }
    if (
      input.frozenBase === undefined ||
      input.runHead === undefined ||
      input.commit !== input.runHead
    ) {
      throw new Error("final-diff review requires frozen base and matching run head");
    }
    if (
      input.worktree.branch !== null ||
      input.worktree.writable ||
      input.allowedPaths.length > 0
    ) {
      throw new Error("final-diff review requires a detached read-only worktree");
    }
  }
  const body = {
    schemaVersion: 1 as const,
    ...structuredClone(input),
    profileId,
    profileFamily,
    ...(implementationProfileFamily === undefined
      ? {}
      : { implementationProfileFamily }),
    scope,
    protectedPaths: [...DefaultProtectedPaths],
  };
  return deepFreeze({
    ...body,
    assignmentHash: sha256(canonicalJson(body)),
  }) as WorkerAssignment;
}
