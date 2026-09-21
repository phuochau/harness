import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "./types.js";
import type { CommandOutput } from "./command.js";

export interface GitVerifyInput {
  readonly commit: string;
  readonly command: CommandOutput;
  readonly observationId?: string;
}

export interface GitVerifyOutput {
  readonly commit: string;
  readonly passed: true;
  readonly evidence: readonly string[];
}

export interface GitVerificationStore {
  get(id: string): Promise<GitVerifyOutput | undefined>;
}

export class GitVerificationError extends Error {}

export class GitVerifyAction
  implements ActionHandler<"git.verify", GitVerifyInput, GitVerifyOutput>
{
  public readonly kind = "git.verify" as const;

  public constructor(private readonly observations?: GitVerificationStore) {}

  public recovery(_input: GitVerifyInput): RecoveryClass {
    return "reconcilable";
  }

  public async execute(
    context: ActionContext,
    intent: EffectIntent<"git.verify", GitVerifyInput>,
  ): Promise<GitVerifyOutput> {
    await context.git.revParse(intent.input.commit);
    if (intent.input.command.exitCode !== 0) {
      throw new GitVerificationError(
        `verification failed for ${intent.input.commit}: ${intent.input.command.stderr}`,
      );
    }
    return {
      commit: intent.input.commit,
      passed: true,
      evidence: [intent.input.command.stdout, intent.input.command.stderr].filter(Boolean),
    };
  }

  public async reconcile(
    _context: ActionContext,
    intent: EffectIntent<"git.verify", GitVerifyInput>,
  ): Promise<ReconcileResult<GitVerifyOutput>> {
    if (intent.input.observationId === undefined || this.observations === undefined) {
      return {
        status: "indeterminate",
        evidence: ["verification observation is not available"],
      };
    }
    const output = await this.observations.get(intent.input.observationId);
    if (output === undefined) return { status: "not_found" };
    return output.commit === intent.input.commit
      ? { status: "observed", output }
      : {
          status: "indeterminate",
          evidence: ["verification observation commit mismatch"],
        };
  }
}

