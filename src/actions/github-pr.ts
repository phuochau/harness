import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "./types.js";

export interface PullRequestInput {
  readonly cwd: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body?: string;
  readonly reviewedCommit: string;
}

export interface PullRequestOutput {
  readonly number: number;
  readonly url: string;
  readonly headRefOid: string;
}

export class PullRequestInvariantError extends Error {}

function parsePullRequests(text: string): readonly PullRequestOutput[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new PullRequestInvariantError("invalid gh PR response");
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).number !== "number" ||
      typeof (item as Record<string, unknown>).url !== "string" ||
      typeof (item as Record<string, unknown>).headRefOid !== "string"
    ) {
      throw new PullRequestInvariantError("invalid gh PR record");
    }
    return item as unknown as PullRequestOutput;
  });
}

export class GitHubPullRequestAction
  implements ActionHandler<"github.pull-request", PullRequestInput, PullRequestOutput>
{
  public readonly kind = "github.pull-request" as const;

  public recovery(_input: PullRequestInput): RecoveryClass {
    return "reconcilable";
  }

  public async execute(
    context: ActionContext,
    intent: EffectIntent<"github.pull-request", PullRequestInput>,
  ): Promise<PullRequestOutput> {
    const prior = await this.reconcile(context, intent);
    if (prior.status === "observed") return prior.output;
    if (prior.status === "indeterminate") {
      throw new PullRequestInvariantError(prior.evidence.join("; "));
    }
    const result = await context.process.run(
      "gh",
      [
        "pr",
        "create",
        "--head",
        intent.input.head,
        "--base",
        intent.input.base,
        "--title",
        intent.input.title,
        "--body",
        intent.input.body ?? "",
      ],
      { cwd: intent.input.cwd, shell: false },
    );
    if (result.exitCode !== 0) throw new PullRequestInvariantError(result.stderr);
    const observed = await this.reconcile(context, intent);
    if (observed.status !== "observed") {
      throw new PullRequestInvariantError("created PR could not be reconciled");
    }
    return observed.output;
  }

  public async reconcile(
    context: ActionContext,
    intent: EffectIntent<"github.pull-request", PullRequestInput>,
  ): Promise<ReconcileResult<PullRequestOutput>> {
    const result = await context.process.run(
      "gh",
      [
        "pr",
        "list",
        "--head",
        intent.input.head,
        "--base",
        intent.input.base,
        "--state",
        "all",
        "--json",
        "number,url,headRefOid",
      ],
      { cwd: intent.input.cwd, shell: false },
    );
    if (result.exitCode !== 0) {
      return { status: "indeterminate", evidence: [result.stderr] };
    }
    let pullRequests: readonly PullRequestOutput[];
    try {
      pullRequests = parsePullRequests(result.stdout);
    } catch (error) {
      return {
        status: "indeterminate",
        evidence: [error instanceof Error ? error.message : String(error)],
      };
    }
    if (pullRequests.length === 0) return { status: "not_found" };
    if (pullRequests.length !== 1) {
      return { status: "indeterminate", evidence: ["multiple matching pull requests"] };
    }
    const pullRequest = pullRequests[0]!;
    return pullRequest.headRefOid === intent.input.reviewedCommit
      ? { status: "observed", output: pullRequest }
      : {
          status: "indeterminate",
          evidence: ["pull request head does not match reviewed commit"],
        };
  }
}
