import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "./types.js";

export interface ApprovalInput {
  readonly requestId: string;
}

export interface ApprovalOutput {
  readonly approved: boolean;
}

export class ApprovalPendingError extends Error {
  public readonly code = "APPROVAL_PENDING";

  public constructor(public readonly requestId: string) {
    super(`approval is pending: ${requestId}`);
  }
}

export class ApprovalAction
  implements ActionHandler<"human.approval", ApprovalInput, ApprovalOutput>
{
  public readonly kind = "human.approval" as const;

  public recovery(_input: ApprovalInput): RecoveryClass {
    return "reconcilable";
  }

  private async observe(
    context: ActionContext,
    requestId: string,
  ): Promise<ReconcileResult<ApprovalOutput>> {
    if (requestId.trim() === "") throw new Error("approval requestId is required");
    const decision = await context.approvals.get(requestId);
    return decision === undefined
      ? { status: "not_found" }
      : { status: "observed", output: { approved: decision.approved } };
  }

  public async execute(
    context: ActionContext,
    intent: EffectIntent<"human.approval", ApprovalInput>,
  ): Promise<ApprovalOutput> {
    const result = await this.observe(context, intent.input.requestId);
    if (result.status === "observed") return result.output;
    throw new ApprovalPendingError(intent.input.requestId);
  }

  public reconcile(
    context: ActionContext,
    intent: EffectIntent<"human.approval", ApprovalInput>,
  ): Promise<ReconcileResult<ApprovalOutput>> {
    return this.observe(context, intent.input.requestId);
  }
}
