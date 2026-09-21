import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
  SealedImplementation,
} from "./types.js";
import { sha256 } from "../shared/sha256.js";
import type {
  IntegrationIdentity,
  NativeGitActionPort,
} from "../git/action-port.js";

export type { IntegrationIdentity } from "../git/action-port.js";

export type GitIntegrateIntent = EffectIntent<
  "git.integrate",
  {
    readonly expectedRunHead: string;
    readonly sealedChange: SealedImplementation;
  }
>;

export interface IntegrationOutput {
  readonly candidateCommit: string;
  readonly candidateRef: string;
  readonly expectedRunHead: string;
  readonly patchId: string;
}

export class IntegrationInvariantError extends Error {
  public readonly code = "INTEGRATION_CONFLICT";
}

function nativeGit(context: ActionContext): NativeGitActionPort {
  const git = context.git as NativeGitActionPort;
  if (typeof git.createIntegrationCandidate !== "function") {
    throw new IntegrationInvariantError("native Git integration port is unavailable");
  }
  return git;
}

function candidateRef(effectKey: string): string {
  return `refs/harness/candidates/${sha256(effectKey).slice(7)}`;
}

function identity(intent: GitIntegrateIntent): IntegrationIdentity {
  return {
    effectKey: intent.idempotencyKey,
    expectedRunHead: intent.input.expectedRunHead,
    change: intent.input.sealedChange,
  };
}

function outputFor(intent: GitIntegrateIntent, commit: string): IntegrationOutput {
  return {
    candidateCommit: commit,
    candidateRef: candidateRef(intent.idempotencyKey),
    expectedRunHead: intent.input.expectedRunHead,
    patchId: intent.input.sealedChange.patchId,
  };
}

export class GitIntegrateAction
  implements ActionHandler<"git.integrate", GitIntegrateIntent["input"], IntegrationOutput>
{
  public readonly kind = "git.integrate" as const;

  public recovery(_input: GitIntegrateIntent["input"]): RecoveryClass {
    return "reconcilable";
  }

  public async execute(
    context: ActionContext,
    intent: GitIntegrateIntent,
  ): Promise<IntegrationOutput> {
    const prior = await this.reconcile(context, intent);
    if (prior.status === "observed") return prior.output;
    if (prior.status === "indeterminate") {
      throw new IntegrationInvariantError(prior.evidence.join("; "));
    }
    try {
      const commit = await nativeGit(context).createIntegrationCandidate(
        candidateRef(intent.idempotencyKey),
        identity(intent),
      );
      return outputFor(intent, commit);
    } catch (error) {
      throw new IntegrationInvariantError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public async reconcile(
    context: ActionContext,
    intent: GitIntegrateIntent,
  ): Promise<ReconcileResult<IntegrationOutput>> {
    const ref = candidateRef(intent.idempotencyKey);
    const matching = await context.git.revParseOptional(ref);
    if (matching === undefined) return { status: "not_found" };
    try {
      await context.git.assertIntegrationMetadata(matching, identity(intent));
    } catch (error) {
      return {
        status: "indeterminate",
        evidence: [
          `integration identity mismatch for ${ref} at ${matching}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    return { status: "observed", output: outputFor(intent, matching) };
  }
}

