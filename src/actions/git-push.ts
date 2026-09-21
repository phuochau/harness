import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "./types.js";

export interface GitPushInput {
  readonly cwd: string;
  readonly localRef: string;
  readonly remote: string;
  readonly remoteRef: string;
  readonly reviewedCommit: string;
}

export interface GitPushOutput {
  readonly remote: string;
  readonly ref: string;
  readonly commit: string;
}

export class GitPushInvariantError extends Error {}

function output(input: GitPushInput): GitPushOutput {
  return { remote: input.remote, ref: input.remoteRef, commit: input.reviewedCommit };
}

export class GitPushAction
  implements ActionHandler<"git.push", GitPushInput, GitPushOutput>
{
  public readonly kind = "git.push" as const;

  public recovery(_input: GitPushInput): RecoveryClass {
    return "reconcilable";
  }

  public async execute(
    context: ActionContext,
    intent: EffectIntent<"git.push", GitPushInput>,
  ): Promise<GitPushOutput> {
    const head = await context.git.revParse(intent.input.localRef);
    if (head !== intent.input.reviewedCommit) {
      throw new GitPushInvariantError("local head moved after final review");
    }
    const result = await context.process.run(
      "git",
      [
        "push",
        intent.input.remote,
        `${intent.input.reviewedCommit}:${intent.input.remoteRef}`,
      ],
      { cwd: intent.input.cwd, shell: false },
    );
    if (result.exitCode !== 0) throw new GitPushInvariantError(result.stderr);
    return output(intent.input);
  }

  public async reconcile(
    context: ActionContext,
    intent: EffectIntent<"git.push", GitPushInput>,
  ): Promise<ReconcileResult<GitPushOutput>> {
    const result = await context.process.run(
      "git",
      ["ls-remote", "--refs", intent.input.remote, intent.input.remoteRef],
      { cwd: intent.input.cwd, shell: false },
    );
    if (result.exitCode !== 0) {
      return { status: "indeterminate", evidence: [result.stderr] };
    }
    if (result.stdout.trim() === "") return { status: "not_found" };
    const remoteCommit = result.stdout.trim().split(/\s+/)[0];
    return remoteCommit === intent.input.reviewedCommit
      ? { status: "observed", output: output(intent.input) }
      : {
          status: "indeterminate",
          evidence: [`remote ref points to ${remoteCommit ?? "unknown"}`],
        };
  }
}

