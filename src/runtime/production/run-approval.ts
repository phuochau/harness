import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "../../actions/types.js";

export interface RunApprovalOutput {
  readonly approved: true;
}

export class RunApprovalAction
  implements ActionHandler<"human.approval", Readonly<Record<string, unknown>>, RunApprovalOutput>
{
  public readonly kind = "human.approval" as const;

  public recovery(_input: Readonly<Record<string, unknown>>): RecoveryClass {
    return "reconcilable";
  }

  public async execute(
    _context: ActionContext,
    _intent: EffectIntent<"human.approval", Readonly<Record<string, unknown>>>,
  ): Promise<RunApprovalOutput> {
    return { approved: true };
  }

  public async reconcile(
    _context: ActionContext,
    _intent: EffectIntent<"human.approval", Readonly<Record<string, unknown>>>,
  ): Promise<ReconcileResult<RunApprovalOutput>> {
    return { status: "observed", output: { approved: true } };
  }
}
