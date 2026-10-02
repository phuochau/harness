import type { EffectIntent } from "../../actions/types.js";
import { link, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createAssignment, type HandoffReference, type WorkerAssignment } from "../../core/assignment.js";
import { validateEvidence } from "../../core/evidence.js";
import type { WorkerKind } from "../../core/routing.js";
import type { RunState } from "../../core/state.js";
import type { ValidatedTaskGraph } from "../../core/task-graph.js";
import type { TaskNode } from "../../contracts/task-graph.js";
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
} from "./pi-worker.js";
import type { DurableRecordStore } from "./records.js";
import type {
  ProductionWorkerInput,
  ProductionWorkerKind,
} from "./worker-action.js";
import { sha256 } from "../../shared/sha256.js";
import { acceptanceCriteriaForTask } from "../../speckit/acceptance-criteria.js";
import type { ResolvedProfiles } from "../../config/profiles.js";

export interface GitWorkerAttemptOptions {
  readonly manifest: RunManifest;
  readonly repository: GitRepository;
  readonly worktrees: WorktreeLifecycle;
  readonly records: DurableRecordStore;
  readonly graph: () => ValidatedTaskGraph;
  readonly readState: () => Promise<RunState>;
  readonly taskVerification: readonly (readonly string[])[];
  readonly profiles: ResolvedProfiles;
  readonly evidenceRoot?: string;
}

async function preserveVerifiedEvidence(
  assignment: WorkerAssignment,
  result: WorkerResult,
  root: string,
): Promise<void> {
  if (!("evidence" in result)) return;
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const item of result.evidence) {
    if (typeof item === "string") continue;
    const source = resolve(assignment.worktree.path, item.path);
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
      throw new Error("handoff_report_oversize_or_invalid_evidence");
    }
    const bytes = await readFile(source);
    if (sha256(bytes) !== item.sha256) throw new Error("verified evidence changed before preservation");
    const destination = join(root, item.sha256.slice(7));
    const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(destination);
        if (sha256(existing) !== item.sha256) throw new Error("preserved evidence hash mismatch");
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function inputRecord(
  intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  profiles: ResolvedProfiles,
): {
  readonly jobId: string;
  readonly stageId: string;
  readonly taskId?: string;
  readonly attempt: number;
  readonly profileId: string;
  readonly family: WorkerKind;
} {
  const input = intent.input;
  if (
    typeof input.jobId !== "string" ||
    typeof input.stageId !== "string" ||
    !Number.isInteger(input.attempt) ||
    Number(input.attempt) < 1 ||
    typeof input.worker !== "string" ||
    profiles.byId[input.worker] === undefined ||
    (input.taskId !== undefined && typeof input.taskId !== "string")
  ) {
    throw new Error("worker effect is missing its immutable job identity");
  }
  return {
    jobId: input.jobId,
    stageId: input.stageId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId as string }),
    attempt: Number(input.attempt),
    profileId: input.worker,
    family: profiles.byId[input.worker]!.family,
  };
}

function implementationResult(
  state: RunState,
  taskId: string,
  profiles: ResolvedProfiles,
): { readonly commit: string; readonly profileId: string; readonly family: WorkerKind } {
  const job = state.jobs[`implement:${taskId}`];
  const result = job?.result;
  if (
    job === undefined ||
    job.worker === undefined || profiles.byId[job.worker] === undefined ||
    result?.outcome !== "completed" ||
    !("role" in result) ||
    result.role !== "implementation"
  ) {
    throw new Error(`task ${taskId} has no accepted implementation result`);
  }
  return {
    commit: result.commit,
    profileId: job.worker,
    family: profiles.byId[job.worker]!.family,
  };
}

function disciplines(role: "implementation" | "review"): readonly string[] {
  return role === "implementation"
    ? ["test-driven-development", "systematic-debugging", "verification-before-completion"]
    : ["requesting-code-review", "verification-before-completion"];
}

async function taskIntent(root: string, specPath: string, task: TaskNode) {
  const spec = await readFile(join(root, specPath), "utf8");
  return {
    taskObjective: task.description,
    acceptanceCriteria: acceptanceCriteriaForTask(spec, task.acceptanceRefs),
  };
}

async function validateEvidenceArtifacts(
  assignment: WorkerAssignment,
  result: WorkerResult,
): Promise<void> {
  if (!("evidence" in result)) return;
  const outputPath = resolve(assignment.worktree.path, ".harness-output");
  const outputInfo = await lstat(outputPath);
  if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
    throw new Error("harness output directory is not a real directory");
  }
  const evidenceRoot = await realpath(outputPath);
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
    handoffReport?: HandoffReference,
  ): Promise<PreparedAttemptBinding> {
    const bound = inputRecord(intent, this.options.profiles);
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
          profileId: bound.profileId,
          profileFamily: bound.family,
          workerKind: bound.family,
          commit: binding.commit,
          allowedPaths: task.ownedPaths,
          requiredDisciplines: disciplines(role),
          verificationCommands: this.options.taskVerification,
          planningArtifacts: artifacts,
          ...await taskIntent(binding.path, this.options.manifest.artifactPaths.spec, task),
          ...(handoffReport === undefined ? {} : { handoffReport }),
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
      const implementation = implementationResult(state, bound.taskId, this.options.profiles);
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
          profileId: bound.profileId,
          profileFamily: bound.family,
          workerKind: bound.family,
          implementationProfileFamily: implementation.family,
          implementationWorkerKind: implementation.family,
          commit: implementation.commit,
          allowedPaths: task.ownedPaths,
          requiredDisciplines: disciplines(role),
          verificationCommands: [],
          planningArtifacts: artifacts,
          ...await taskIntent(binding.path, this.options.manifest.artifactPaths.spec, task),
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
        profileId: bound.profileId,
        profileFamily: bound.family,
        workerKind: bound.family,
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

  public async stagePrompt(
    binding: LifecycleWorktreeBinding,
    prompt: string,
  ): Promise<string> {
    const relativePath = ".harness-output/assignment.md";
    const path = join(binding.path, relativePath);
    try {
      await writeFile(path, prompt, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || await readFile(path, "utf8") !== prompt) {
        throw new Error("persisted worker assignment prompt changed");
      }
    }
    return relativePath;
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
    if (this.options.evidenceRoot !== undefined) {
      await preserveVerifiedEvidence(assignment, result, this.options.evidenceRoot);
    }
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

  public abort(binding: LifecycleWorktreeBinding): Promise<void> {
    return this.options.worktrees.quarantineCancelled(binding);
  }
}
