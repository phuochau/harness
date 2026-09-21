import type { CommandInput, CommandOutput } from "../../actions/command.js";
import type { GitIntegrateIntent, IntegrationOutput } from "../../actions/git-integrate.js";
import type {
  ProjectTaskStatusIntent,
  TaskFinalizationOutput,
} from "../../actions/git-project-task-status.js";
import type { GitPushInput, GitPushOutput } from "../../actions/git-push.js";
import type { PullRequestInput, PullRequestOutput } from "../../actions/github-pr.js";
import type { EffectIntent, SealedImplementation } from "../../actions/types.js";
import type { RunState } from "../../core/state.js";
import type { WorkerResult } from "../../contracts/worker-result.js";
import type { WorktreeLifecycle } from "../../git/workspace-lifecycle.js";
import type { LifecycleWorktreeBinding } from "../../git/worktrees.js";
import type { GitRepository } from "../../git/repository.js";
import type { RunManifest } from "../../state/run-manifest.js";
import type { DurableRecordStore } from "./records.js";

type HighLevelIntent<K extends string> = EffectIntent<K, Readonly<Record<string, unknown>>>;

export interface BoundCommandInput extends CommandInput {
  readonly workspace: LifecycleWorktreeBinding;
}

export interface ProductionActionBinderOptions {
  readonly manifest: RunManifest;
  readonly repository: GitRepository;
  readonly worktrees: WorktreeLifecycle;
  readonly records: DurableRecordStore;
  readonly readState: () => Promise<RunState>;
  readonly tasksSemanticHash: () => string;
}

function record(value: unknown, label: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, any>;
}

function string(value: Record<string, any>, key: string): string {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`effect input requires ${key}`);
  }
  return value[key];
}

function attempt(value: Record<string, any>): number {
  if (!Number.isInteger(value.attempt) || value.attempt < 1) {
    throw new Error("effect input requires a positive attempt");
  }
  return value.attempt;
}

function successfulImplementation(state: RunState, taskId: string): WorkerResult & {
  readonly outcome: "completed";
  readonly role: "implementation";
  readonly commit: string;
} {
  const result = state.jobs[`implement:${taskId}`]?.result;
  if (result?.outcome !== "completed" || !("role" in result) || result.role !== "implementation") {
    throw new Error(`task ${taskId} has no completed implementation`);
  }
  return result;
}

function effectKey(
  action: string,
  stage: string,
  taskId: string | undefined,
  state: RunState,
): string {
  const jobId = taskId === undefined ? stage : `${stage}:${taskId}`;
  const generation = state.jobs[jobId]?.attempt;
  if (!Number.isInteger(generation) || generation! < 1) {
    throw new Error(`missing attempt for ${jobId}`);
  }
  return `${action}:${jobId}:${generation}`;
}

function validateSealed(value: unknown): SealedImplementation {
  const item = record(value, "sealed change");
  if (
    typeof item.baseCommit !== "string" || typeof item.headCommit !== "string" ||
    typeof item.sourceTree !== "string" || typeof item.patchId !== "string" ||
    !Array.isArray(item.changedPaths) || item.changedPaths.some((path: unknown) => typeof path !== "string")
  ) throw new Error("invalid sealed change");
  return {
    baseCommit: item.baseCommit,
    headCommit: item.headCommit,
    sourceTree: item.sourceTree,
    patchId: item.patchId,
    changedPaths: item.changedPaths,
  };
}

export class ProductionActionBinders {
  public constructor(private readonly options: ProductionActionBinderOptions) {}

  public async command(intent: HighLevelIntent<"command.run">): Promise<BoundCommandInput> {
    const input = record(intent.input, "command effect");
    const stageId = string(input, "stageId");
    const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
    const state = await this.options.readState();
    let commit: string;
    if (stageId === "verify") {
      if (taskId === undefined) throw new Error("task verification requires taskId");
      commit = successfulImplementation(state, taskId).commit;
    } else if (stageId === "post_integrate_verify") {
      if (taskId === undefined) throw new Error("candidate verification requires taskId");
      const integration = await this.options.records.get<IntegrationOutput>(
        "action-completed",
        effectKey("git.integrate", "integrate", taskId, state),
      );
      if (integration === undefined) throw new Error(`task ${taskId} has no integration candidate`);
      commit = integration.candidateCommit;
    } else if (stageId === "final_verify") {
      commit = await this.options.repository.revParse(this.options.manifest.runRef);
    } else {
      throw new Error(`command stage ${stageId} has no production binding`);
    }
    const workspace = await this.options.worktrees.openVerification({
      runId: this.options.manifest.runId,
      ...(taskId === undefined ? {} : { taskId: `${taskId}-${stageId}` }),
      attempt: attempt(input),
      commit,
    });
    if (!Array.isArray(input.argv) || input.argv.some((item: unknown) => typeof item !== "string")) {
      throw new Error("verification command argv is invalid");
    }
    if (
      input.probe !== undefined &&
      (!Array.isArray(input.probe) || input.probe.some((item: unknown) => typeof item !== "string"))
    ) {
      throw new Error("verification command probe is invalid");
    }
    return {
      argv: input.argv,
      ...(input.probe === undefined ? {} : { probe: input.probe }),
      cwd: workspace.path,
      expectedCommit: commit,
      workspace,
    };
  }

  public async afterCommand(input: BoundCommandInput): Promise<void> {
    await this.options.worktrees.releaseCompleted(input.workspace);
  }

  public async integrate(
    intent: HighLevelIntent<"git.integrate">,
  ): Promise<GitIntegrateIntent["input"]> {
    const input = record(intent.input, "integration effect");
    const taskId = string(input, "taskId");
    const sealedRecord = await this.options.records.get<unknown>(
      "sealed-change",
      `implement:${taskId}`,
    );
    if (sealedRecord === undefined) throw new Error(`task ${taskId} has no sealed change`);
    return {
      expectedRunHead: await this.options.repository.revParse(this.options.manifest.runRef),
      sealedChange: validateSealed(sealedRecord),
    };
  }

  public async finalize(
    intent: HighLevelIntent<"git.project-task-status">,
  ): Promise<ProjectTaskStatusIntent["input"]> {
    const input = record(intent.input, "task finalization effect");
    const taskId = string(input, "taskId");
    const state = await this.options.readState();
    const integrateKey = effectKey("git.integrate", "integrate", taskId, state);
    const integration = await this.options.records.get<IntegrationOutput>(
      "action-completed",
      integrateKey,
    );
    if (integration === undefined) throw new Error(`task ${taskId} integration is missing`);
    const sealedRecord = await this.options.records.get<unknown>("sealed-change", `implement:${taskId}`);
    if (sealedRecord === undefined) throw new Error(`task ${taskId} sealed change is missing`);
    const verificationKey = effectKey("command.run", "post_integrate_verify", taskId, state);
    return {
      runRef: this.options.manifest.runRef,
      expectedRunHead: integration.expectedRunHead,
      candidateCommit: integration.candidateCommit,
      integrationIdentity: {
        effectKey: integrateKey,
        expectedRunHead: integration.expectedRunHead,
        change: validateSealed(sealedRecord),
      },
      verificationEventId: `verification-passed:${verificationKey}`,
      taskId,
      tasksPath: this.options.manifest.artifactPaths.tasks,
      tasksSemanticHash: this.options.tasksSemanticHash(),
    };
  }

  public async push(_intent: HighLevelIntent<"git.push">): Promise<GitPushInput> {
    const state = await this.options.readState();
    const reviewedCommit = state.jobs.final_review?.reviewCommit;
    if (reviewedCommit === undefined) throw new Error("final review has not approved a commit");
    return {
      cwd: this.options.manifest.repositoryRoot,
      localRef: this.options.manifest.runRef,
      remote: this.options.manifest.remote,
      remoteRef: this.options.manifest.runRef,
      reviewedCommit,
    };
  }

  public async pullRequest(
    _intent: HighLevelIntent<"github.pull-request">,
  ): Promise<PullRequestInput> {
    const state = await this.options.readState();
    const reviewedCommit = state.jobs.final_review?.reviewCommit;
    if (reviewedCommit === undefined) throw new Error("final review has not approved a commit");
    return {
      cwd: this.options.manifest.repositoryRoot,
      head: this.options.manifest.runRef.replace(/^refs\/heads\//, ""),
      base: this.options.manifest.baseBranch,
      title: `Harness run ${this.options.manifest.runId}`,
      body: `Automated implementation for harness run ${this.options.manifest.runId}.`,
      reviewedCommit,
    };
  }
}

export function validateBoundCommand(value: unknown): BoundCommandInput {
  const input = record(value, "bound command");
  const workspace = record(input.workspace, "verification workspace");
  if (
    !Array.isArray(input.argv) ||
    input.argv.length === 0 ||
    input.argv.some((item: unknown) => typeof item !== "string") ||
    typeof input.cwd !== "string" ||
    typeof input.expectedCommit !== "string" ||
    typeof workspace.id !== "string" ||
    typeof workspace.path !== "string" ||
    typeof workspace.commit !== "string" ||
    typeof workspace.role !== "string"
  ) throw new Error("invalid bound command");
  return input as BoundCommandInput;
}

export function validateCommandOutput(value: unknown): CommandOutput {
  const output = record(value, "command output");
  if (
    typeof output.exitCode !== "number" ||
    typeof output.stdout !== "string" ||
    typeof output.stderr !== "string" ||
    (output.commit !== undefined && typeof output.commit !== "string")
  ) {
    throw new Error("invalid command output");
  }
  return output as CommandOutput;
}

export function validateIntegrationInput(value: unknown): GitIntegrateIntent["input"] {
  const input = record(value, "integration input");
  return { expectedRunHead: string(input, "expectedRunHead"), sealedChange: validateSealed(input.sealedChange) };
}

export function validateIntegrationOutput(value: unknown): IntegrationOutput {
  const output = record(value, "integration output");
  return {
    candidateCommit: string(output, "candidateCommit"),
    candidateRef: string(output, "candidateRef"),
    expectedRunHead: string(output, "expectedRunHead"),
    patchId: string(output, "patchId"),
  };
}

export function validateFinalizationInput(value: unknown): ProjectTaskStatusIntent["input"] {
  const input = record(value, "task finalization input");
  const identity = record(input.integrationIdentity, "integration identity");
  const tasksSemanticHash = string(input, "tasksSemanticHash");
  if (!/^sha256:[0-9a-f]{64}$/.test(tasksSemanticHash)) {
    throw new Error("invalid task semantic hash");
  }
  return {
    runRef: string(input, "runRef"),
    expectedRunHead: string(input, "expectedRunHead"),
    candidateCommit: string(input, "candidateCommit"),
    integrationIdentity: {
      effectKey: string(identity, "effectKey"),
      expectedRunHead: string(identity, "expectedRunHead"),
      change: validateSealed(identity.change),
    },
    verificationEventId: string(input, "verificationEventId"),
    taskId: string(input, "taskId"),
    tasksPath: string(input, "tasksPath"),
    tasksSemanticHash,
  };
}

export function validateFinalizationOutput(value: unknown): TaskFinalizationOutput {
  const output = record(value, "task finalization output");
  const tasksSemanticHash = string(output, "tasksSemanticHash");
  if (!/^sha256:[0-9a-f]{64}$/.test(tasksSemanticHash)) {
    throw new Error("invalid finalization semantic hash");
  }
  return {
    targetCommit: string(output, "targetCommit"),
    candidateCommit: string(output, "candidateCommit"),
    taskId: string(output, "taskId"),
    tasksSemanticHash,
  };
}

export function validatePushInput(value: unknown): GitPushInput {
  const input = record(value, "push input");
  return {
    cwd: string(input, "cwd"),
    localRef: string(input, "localRef"),
    remote: string(input, "remote"),
    remoteRef: string(input, "remoteRef"),
    reviewedCommit: string(input, "reviewedCommit"),
  };
}

export function validatePushOutput(value: unknown): GitPushOutput {
  const output = record(value, "push output");
  return {
    remote: string(output, "remote"),
    ref: string(output, "ref"),
    commit: string(output, "commit"),
  };
}

export function validatePullRequestInput(value: unknown): PullRequestInput {
  const input = record(value, "pull request input");
  const body = input.body;
  if (body !== undefined && typeof body !== "string") throw new Error("invalid pull request body");
  return {
    cwd: string(input, "cwd"),
    head: string(input, "head"),
    base: string(input, "base"),
    title: string(input, "title"),
    ...(body === undefined ? {} : { body }),
    reviewedCommit: string(input, "reviewedCommit"),
  };
}

export function validatePullRequestOutput(value: unknown): PullRequestOutput {
  const output = record(value, "pull request output");
  if (!Number.isInteger(output.number) || output.number < 1) {
    throw new Error("invalid pull request number");
  }
  return {
    number: output.number,
    url: string(output, "url"),
    headRefOid: string(output, "headRefOid"),
  };
}
