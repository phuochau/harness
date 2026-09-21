import { ActionRegistry } from "./registry.js";
import type {
  ActionContext,
  ActionDependencies,
  EffectIntent,
} from "./types.js";

export class IndeterminateEffect extends Error {
  public readonly code = "INDETERMINATE_EFFECT";

  public constructor(
    public readonly intent: EffectIntent,
    public readonly evidence: readonly string[],
  ) {
    super(`indeterminate effect: ${intent.action} (${intent.idempotencyKey})`);
  }
}

export class EffectExecutor {
  public constructor(
    private readonly registry: ActionRegistry,
    private readonly dependencies: ActionDependencies,
  ) {}

  private contextFor(isRecovery: boolean): ActionContext {
    return Object.freeze({ ...this.dependencies, isRecovery });
  }

  public async runFresh<I, O>(intent: EffectIntent<string, I>): Promise<O> {
    const handler = this.registry.get<string, I, O>(intent.action);
    const recovery = handler.recovery(intent.input);
    if (recovery !== intent.recovery) {
      throw new Error(`recovery mismatch for ${intent.action}`);
    }
    return handler.execute(this.contextFor(false), intent);
  }

  public async recover<I, O>(intent: EffectIntent<string, I>): Promise<O> {
    const handler = this.registry.get<string, I, O>(intent.action);
    const recovery = handler.recovery(intent.input);
    if (recovery !== intent.recovery) {
      throw new Error(`recovery mismatch for ${intent.action}`);
    }
    const prior = await handler.reconcile(this.contextFor(true), intent);
    if (prior.status === "observed") return prior.output;
    if (prior.status === "indeterminate" || recovery === "non_retryable") {
      throw new IndeterminateEffect(
        intent as EffectIntent,
        prior.status === "indeterminate" ? prior.evidence : [],
      );
    }
    return handler.execute(this.contextFor(true), intent);
  }

  public async retryCleanup<I>(intent: EffectIntent<string, I>): Promise<void> {
    const handler = this.registry.get<string, I, unknown>(intent.action);
    if (handler.recovery(intent.input) !== intent.recovery) {
      throw new Error(`recovery mismatch for ${intent.action}`);
    }
    const result = await handler.reconcile(this.contextFor(true), intent);
    if (result.status === "observed") return;
    if (result.status === "indeterminate") {
      throw new IndeterminateEffect(intent as EffectIntent, result.evidence);
    }
    throw new Error(
      `completed effect cleanup could not be reconciled: ${intent.idempotencyKey}`,
    );
  }
}
