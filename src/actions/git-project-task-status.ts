import type {
  IntegrationIdentity,
  NativeGitActionPort,
} from "../git/action-port.js";
import { sha256 } from "../shared/sha256.js";
import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "./types.js";

export interface VerificationObservation {
  readonly eventType: "verification.passed" | "verification.failed";
  readonly commit: string;
}

export interface VerificationObservationStore {
  get(id: string): Promise<VerificationObservation | undefined>;
}

export type ProjectTaskStatusIntent = EffectIntent<
  "git.project-task-status",
  {
    readonly runRef: string;
    readonly expectedRunHead: string;
    readonly candidateCommit: string;
    readonly integrationIdentity: IntegrationIdentity;
    readonly verificationEventId: string;
    readonly taskId: string;
    readonly tasksPath: string;
    readonly tasksSemanticHash: string;
  }
>;

export interface TaskFinalizationOutput {
  readonly targetCommit: string;
  readonly candidateCommit: string;
  readonly taskId: string;
}

export class TaskFinalizationInvariantError extends Error {}

function normalizedTaskSemantics(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^(\s*[-*]\s+\[)[ xX](\])/gm, "$1 $2");
}

export function tasksSemanticHash(text: string): string {
  return sha256(normalizedTaskSemantics(text));
}

function checkedTask(text: string, taskId: string): string {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^(\\s*[-*]\\s+\\[)([ xX])(\\]\\s+${escaped}(?:\\s|$).*)$`,
    "gm",
  );
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new TaskFinalizationInvariantError(
      `expected exactly one task checkbox for ${taskId}, found ${matches.length}`,
    );
  }
  if (matches[0]?.[2]?.toLowerCase() === "x") {
    throw new TaskFinalizationInvariantError(`task ${taskId} is already checked in candidate`);
  }
  return text.replace(pattern, "$1x$3");
}

function nativeGit(context: ActionContext): NativeGitActionPort {
  const git = context.git as NativeGitActionPort;
  if (typeof git.buildTreeWithTextFile !== "function") {
    throw new TaskFinalizationInvariantError("native Git projection port is unavailable");
  }
  return git;
}

function outputFor(intent: ProjectTaskStatusIntent, commit: string): TaskFinalizationOutput {
  return {
    targetCommit: commit,
    candidateCommit: intent.input.candidateCommit,
    taskId: intent.input.taskId,
  };
}

export class GitProjectTaskStatusAction
  implements
    ActionHandler<
      "git.project-task-status",
      ProjectTaskStatusIntent["input"],
      TaskFinalizationOutput
    >
{
  public readonly kind = "git.project-task-status" as const;

  public constructor(private readonly events: VerificationObservationStore) {}

  public recovery(_input: ProjectTaskStatusIntent["input"]): RecoveryClass {
    return "reconcilable";
  }

  private async assertVerification(intent: ProjectTaskStatusIntent): Promise<void> {
    const event = await this.events.get(intent.input.verificationEventId);
    if (
      event?.eventType !== "verification.passed" ||
      event.commit !== intent.input.candidateCommit
    ) {
      throw new TaskFinalizationInvariantError(
        "candidate does not have the bound passing verification observation",
      );
    }
  }

  private async projectedTree(
    git: NativeGitActionPort,
    intent: ProjectTaskStatusIntent,
  ): Promise<string> {
    const original = await git.readTextAt(
      intent.input.candidateCommit,
      intent.input.tasksPath,
    );
    if (tasksSemanticHash(original) !== intent.input.tasksSemanticHash) {
      throw new TaskFinalizationInvariantError("tasks semantic hash changed before projection");
    }
    const projected = checkedTask(original, intent.input.taskId);
    if (tasksSemanticHash(projected) !== intent.input.tasksSemanticHash) {
      throw new TaskFinalizationInvariantError("task checkbox changed semantic content");
    }
    return git.buildTreeWithTextFile(
      intent.input.candidateCommit,
      intent.input.tasksPath,
      projected,
    );
  }

  private trailers(intent: ProjectTaskStatusIntent): Readonly<Record<string, string>> {
    return {
      "Harness-Candidate": intent.input.candidateCommit,
      "Harness-Effect-Key": intent.idempotencyKey,
      "Harness-Expected-Run-Head": intent.input.expectedRunHead,
      "Harness-Task-ID": intent.input.taskId,
      "Harness-Tasks-Semantic-Hash": intent.input.tasksSemanticHash,
      "Harness-Verification-Event": intent.input.verificationEventId,
    };
  }

  public async execute(
    context: ActionContext,
    intent: ProjectTaskStatusIntent,
  ): Promise<TaskFinalizationOutput> {
    const prior = await this.reconcile(context, intent);
    if (prior.status === "observed") return prior.output;
    if (prior.status === "indeterminate") {
      throw new TaskFinalizationInvariantError(prior.evidence.join("; "));
    }
    await context.git.assertIntegrationMetadata(
      intent.input.candidateCommit,
      intent.input.integrationIdentity,
    );
    await this.assertVerification(intent);
    const git = nativeGit(context);
    const tree = await this.projectedTree(git, intent);
    const finalCommit = await context.git.commitTree(tree, {
      parent: intent.input.expectedRunHead,
      trailers: this.trailers(intent),
    });
    try {
      await context.git.updateRefCas(
        intent.input.runRef,
        finalCommit,
        intent.input.expectedRunHead,
      );
    } catch (error) {
      throw new TaskFinalizationInvariantError(
        `stale run head: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return outputFor(intent, finalCommit);
  }

  public async reconcile(
    context: ActionContext,
    intent: ProjectTaskStatusIntent,
  ): Promise<ReconcileResult<TaskFinalizationOutput>> {
    const commit = await context.git.findCommitByTrailer(
      intent.input.runRef,
      "Harness-Effect-Key",
      intent.idempotencyKey,
    );
    if (commit === undefined) return { status: "not_found" };
    try {
      await context.git.assertIntegrationMetadata(
        intent.input.candidateCommit,
        intent.input.integrationIdentity,
      );
      await this.assertVerification(intent);
      const git = nativeGit(context);
      const parents = await git.commitParents(commit);
      if (parents.length !== 1 || parents[0] !== intent.input.expectedRunHead) {
        throw new Error("final commit parent mismatch");
      }
      const trailers = await git.commitTrailers(commit);
      for (const [key, value] of Object.entries(this.trailers(intent))) {
        if (trailers.get(key) !== value) throw new Error(`final trailer mismatch: ${key}`);
      }
      if ((await git.treeOf(commit)) !== (await this.projectedTree(git, intent))) {
        throw new Error("final tree does not match candidate plus task projection");
      }
      if ((await context.git.revParse(intent.input.runRef)) !== commit) {
        throw new Error(`final commit ${commit} exists but run ref does not point to it`);
      }
    } catch (error) {
      return {
        status: "indeterminate",
        evidence: [error instanceof Error ? error.message : String(error)],
      };
    }
    return { status: "observed", output: outputFor(intent, commit) };
  }
}

