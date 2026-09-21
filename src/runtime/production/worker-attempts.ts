import type { EffectIntent } from "../../actions/types.js";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createAssignment, type WorkerAssignment } from "../../core/assignment.js";
import { validateEvidence } from "../../core/evidence.js";
import type { WorkerKind } from "../../core/routing.js";
import type { RunState } from "../../core/state.js";
import type { ValidatedTaskGraph } from "../../core/task-graph.js";
import type { WorkerResult } from "../../contracts/worker-result.js";
import { taskBranchName } from "../../git/branches.js";
import type { GitRepository } from "../../git/repository.js";
import type { WorktreeLifecycle } from "../../git/workspace-lifecycle.js";
import type { LifecycleWorktreeBinding } from "../../git/worktrees.js";
import type { RunManifest } from "../../state/run-manifest.js";
import { GitEvidence } from "./git-evidence.js";
import type {
  PreparedAttemptBinding,
  ProductionWorkerAttemptPort,
} from "./herdr-worker.js";
import type { DurableRecordStore } from "./records.js";
import type {
  ProductionWorkerInput,
  ProductionWorkerKind,
} from "./worker-action.js";
import { sha256 } from "../../shared/sha256.js";

export interface GitWorkerAttemptOptions {
  readonly manifest: RunManifest;
  readonly repository: GitRepository;
  readonly worktrees: WorktreeLifecycle;
  readonly records: DurableRecordStore;
  readonly graph: () => ValidatedTaskGraph;
  readonly readState: () => Promise<RunState>;
  readonly taskVerification: readonly (readonly string[])[];
}

function inputRecord(
  intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
): {
  readonly jobId: string;
  readonly stageId: string;
  readonly taskId?: string;
  readonly attempt: number;
  readonly worker: WorkerKind;
} {
  const input = intent.input;
  if (
    typeof input.jobId !== "string" ||
    typeof input.stageId !== "string" ||
    !Number.isInteger(input.attempt) ||
    Number(input.attempt) < 1 ||
    !["codex", "devin", "claude"].includes(String(input.worker)) ||
    (input.taskId !== undefined && typeof input.taskId !== "string")
  ) {
    throw new Error("worker effect is missing its immutable job identity");
  }
  return {
    jobId: input.jobId,
    stageId: input.stageId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId as string }),
    attempt: Number(input.attempt),
    worker: input.worker as WorkerKind,
  };
}

function implementationResult(
  state: RunState,
  taskId: string,
): { readonly commit: string; readonly worker: WorkerKind } {
  const job = state.jobs[`implement:${taskId}`];
  const result = job?.result;
  if (
    job === undefined ||
    !["codex", "devin", "claude"].includes(job.worker ?? "") ||
    result?.outcome !== "completed" ||
    !("role" in result) ||
    result.role !== "implementation"
  ) {
    throw new Error(`task ${taskId} has no accepted implementation result`);
  }
  return { commit: result.commit, worker: job.worker as WorkerKind };
}

function disciplines(role: "implementation" | "review"): readonly string[] {
  return role === "implementation"
    ? ["test-driven-development", "systematic-debugging", "verification-before-completion"]
    : ["requesting-code-review", "verification-before-completion"];
}

async function validateEvidenceArtifacts(
  assignment: WorkerAssignment,
  result: WorkerResult,
): Promise<void> {
  if (!("evidence" in result)) return;
  const evidenceRoot = await realpath(resolve(assignment.worktree.path, ".harness-output"));
  for (const item of result.evidence) {
    if (typeof item === "string") throw new Error("structured evidence artifact is required");
    if (isAbsolute(item.path)) throw new Error(`evidence path must be relative: ${item.path}`);
    const lexical = relative(
      resolve(assignment.worktree.path, ".harness-output"),
      resolve(assignment.worktree.path, item.path),
    );
    if (lexical === "" || lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
      throw new Error(`evidence path escaped .harness-output: ${item.path}`);
    }
    const artifact = await realpath(resolve(assignment.worktree.path, item.path));
    const confined = relative(evidenceRoot, artifact);
    if (confined === "" || confined === ".." || confined.startsWith(`..${sep}`) || isAbsolute(confined)) {
      throw new Error(`evidence artifact escaped .harness-output: ${item.path}`);
    }
    const stat = await lstat(artifact);
    if (!stat.isFile()) throw new Error(`evidence artifact is not a regular file: ${item.path}`);
    const actual = sha256(await readFile(artifact));
    if (actual !== item.sha256) throw new Error(`evidence hash mismatch: ${item.path}`);
  }
}

export class GitWorkerAttemptPort implements ProductionWorkerAttemptPort {
  private readonly evidence: GitEvidence;

  public constructor(private readonly options: GitWorkerAttemptOptions) {
    this.evidence = new GitEvidence(options.manifest.repositoryRoot);
  }

  public async prepare(
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<PreparedAttemptBinding> {
    const bound = inputRecord(intent);
    const graph = this.options.graph();
    const artifacts = Object.values(this.options.manifest.artifactPaths);
    const role = intent.action === "worker.execute" ? "implementation" : "review";
    if (role === "implementation") {
      if (bound.taskId === undefined) throw new Error("implementation requires taskId");
      const task = graph.byId.get(bound.taskId);
      if (task === undefined) throw new Error(`unknown task ${bound.taskId}`);
      const runHead = await this.options.repository.revParse(this.options.manifest.runRef);
      const ref = `refs/heads/${taskBranchName(this.options.manifest.runId, bound.taskId)}`;
      const existing = await this.options.repository.revParseOptional(ref);
      const taskBranch = await this.options.repository.ensureTaskBranch(
        this.options.manifest.runId,
        bound.taskId,
        runHead,
        existing ?? runHead,
      );
      const binding = await this.options.worktrees.openImplementation({
        runId: this.options.manifest.runId,
        taskId: bound.taskId,
        attempt: bound.attempt,
        branch: taskBranch.name,
        baseCommit: taskBranch.commit,
        ownedPaths: task.ownedPaths,
      });
      return {
        binding,
        assignment: createAssignment({
          runId: this.options.manifest.runId,
          stageId: bound.stageId,
          jobId: bound.jobId,
          itemKey: bound.taskId,
          taskId: bound.taskId,
          attempt: bound.attempt,
          role,
          workerKind: bound.worker,
          commit: binding.commit,
          allowedPaths: task.ownedPaths,
          requiredDisciplines: disciplines(role),
          verificationCommands: this.options.taskVerification,
          planningArtifacts: artifacts,
          worktree: {
            role: "implementation",
            path: binding.path,
            branch: binding.branch,
            commit: binding.commit,
            writable: true,
          },
        }),
      };
    }

    const state = await this.options.readState();
    if (bound.taskId !== undefined) {
      const task = graph.byId.get(bound.taskId);
      if (task === undefined) throw new Error(`unknown task ${bound.taskId}`);
      const implementation = implementationResult(state, bound.taskId);
      const binding = await this.options.worktrees.openReview({
        runId: this.options.manifest.runId,
        taskId: bound.taskId,
        attempt: bound.attempt,
        commit: implementation.commit,
      });
      return {
        binding,
        assignment: createAssignment({
          runId: this.options.manifest.runId,
          stageId: bound.stageId,
          jobId: bound.jobId,
          itemKey: bound.taskId,
          taskId: bound.taskId,
          attempt: bound.attempt,
          role,
          workerKind: bound.worker,
          implementationWorkerKind: implementation.worker,
          commit: implementation.commit,
          allowedPaths: task.ownedPaths,
          requiredDisciplines: disciplines(role),
          verificationCommands: [],
          planningArtifacts: artifacts,
          worktree: {
            role: "review",
            path: binding.path,
            branch: null,
            commit: binding.commit,
            writable: false,
          },
        }),
      };
    }

    const runHead = await this.options.repository.revParse(this.options.manifest.runRef);
    const binding = await this.options.worktrees.openReview({
      runId: this.options.manifest.runId,
      attempt: bound.attempt,
      commit: runHead,
    });
    return {
      binding,
      assignment: createAssignment({
        runId: this.options.manifest.runId,
        stageId: bound.stageId,
        jobId: bound.jobId,
        itemKey: "run",
        reviewScope: "final_diff",
        frozenBase: this.options.manifest.frozenBase,
        runHead,
        attempt: bound.attempt,
        role,
        workerKind: bound.worker,
        commit: runHead,
        allowedPaths: [],
        requiredDisciplines: disciplines(role),
        verificationCommands: [],
        planningArtifacts: artifacts,
        worktree: {
          role: "review",
          path: binding.path,
          branch: null,
          commit: binding.commit,
          writable: false,
        },
      }),
    };
  }

  public async accept(
    assignment: WorkerAssignment,
    result: WorkerResult,
    binding: LifecycleWorktreeBinding,
  ): Promise<void> {
    if (result.assignmentHash !== assignment.assignmentHash) {
      throw new Error("worker result assignment hash mismatch");
    }
    if (result.outcome === "blocked" || result.outcome === "failed") return;
    await validateEvidenceArtifacts(assignment, result);
    await validateEvidence(assignment, result, this.evidence);
    if (assignment.role === "implementation") {
      if (result.outcome !== "completed" || result.role !== "implementation") {
        throw new Error("implementation result is not completed");
      }
      const sealed = await this.options.worktrees.sealImplementation(binding, result.commit);
      await this.options.records.put("sealed-change", assignment.jobId, {
        assignmentHash: assignment.assignmentHash,
        ...sealed,
      });
      return;
    }
    await this.options.worktrees.validateReview(binding);
  }

  public release(binding: LifecycleWorktreeBinding): Promise<void> {
    return this.options.worktrees.releaseCompleted(binding);
  }
}
