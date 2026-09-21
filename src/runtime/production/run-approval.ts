import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "../../actions/types.js";

export interface RunApprovalOutput {
  readonly approved: boolean;
}

export class RunApprovalPendingError extends Error {
  public readonly code = "APPROVAL_PENDING";
  public readonly deferred = true;

  public constructor(public readonly requestId: string) {
    super(`approval is pending: ${requestId}`);
  }
}

export class RunApprovalAction
  implements ActionHandler<"human.approval", Readonly<Record<string, unknown>>, RunApprovalOutput>
{
  public readonly kind = "human.approval" as const;

  public recovery(_input: Readonly<Record<string, unknown>>): RecoveryClass {
    return "reconcilable";
  }

  public async execute(
    context: ActionContext,
    intent: EffectIntent<"human.approval", Readonly<Record<string, unknown>>>,
  ): Promise<RunApprovalOutput> {
    const decision = await context.approvals.get(intent.idempotencyKey);
    if (decision === undefined) throw new RunApprovalPendingError(intent.idempotencyKey);
    return { approved: decision.approved };
  }

  public async reconcile(
    context: ActionContext,
    intent: EffectIntent<"human.approval", Readonly<Record<string, unknown>>>,
  ): Promise<ReconcileResult<RunApprovalOutput>> {
    const decision = await context.approvals.get(intent.idempotencyKey);
    return decision === undefined
      ? { status: "not_found" }
      : { status: "observed", output: { approved: decision.approved } };
  }
}
