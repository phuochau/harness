import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "../../actions/types.js";
import type { JsonValue } from "../../contracts/common.js";
import type { DurableRecordStore } from "./records.js";

export interface ProductionInputBinder<K extends string, I, O> {
  bind(intent: EffectIntent<K, Readonly<Record<string, unknown>>>): Promise<I>;
  mapOutput?(input: I, output: O): O;
  afterCompleted?(
    input: I,
    output: O,
    intent: EffectIntent<K, Readonly<Record<string, unknown>>>,
  ): Promise<void>;
}

export interface DurableBoundActionOptions<K extends string, I, O> {
  readonly records: DurableRecordStore;
  readonly handler: ActionHandler<K, I, O>;
  readonly binder: ProductionInputBinder<K, I, O>;
  readonly recovery:
    | RecoveryClass
    | ((input: Readonly<Record<string, unknown>>) => RecoveryClass);
  readonly validateInput: (value: unknown) => I;
  readonly validateOutput: (value: unknown) => O;
}

function safeCleanupMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|password|secret|authorization)=\S+/gi, "$1=[REDACTED]");
}

export class DurableBoundAction<K extends string, I, O>
  implements ActionHandler<K, Readonly<Record<string, unknown>>, O>
{
  public readonly kind: K;

  public constructor(private readonly options: DurableBoundActionOptions<K, I, O>) {
    this.kind = options.handler.kind;
  }

  public recovery(input: Readonly<Record<string, unknown>>): RecoveryClass {
    return typeof this.options.recovery === "function"
      ? this.options.recovery(input)
      : this.options.recovery;
  }

  private async bound(
    intent: EffectIntent<K, Readonly<Record<string, unknown>>>,
  ): Promise<I> {
    const existing = await this.options.records.get<unknown>(
      "bound-input",
      intent.idempotencyKey,
    );
    if (existing !== undefined) return this.options.validateInput(existing);
    const input = await this.options.binder.bind(intent);
    return this.options.validateInput(await this.options.records.put(
      "bound-input",
      intent.idempotencyKey,
      input as unknown as JsonValue,
    ));
  }

  private async completed(
    intent: EffectIntent<K, Readonly<Record<string, unknown>>>,
  ): Promise<O | undefined> {
    const output = await this.options.records.get<unknown>(
      "action-completed",
      intent.idempotencyKey,
    );
    return output === undefined ? undefined : this.options.validateOutput(output);
  }

  private delegated(
    intent: EffectIntent<K, Readonly<Record<string, unknown>>>,
    input: I,
  ): EffectIntent<K, I> {
    return { ...intent, input };
  }

  private async afterCompleted(
    input: I,
    output: O,
    intent: EffectIntent<K, Readonly<Record<string, unknown>>>,
  ): Promise<void> {
    try {
      await this.options.binder.afterCompleted?.(input, output, intent);
      await this.options.records.remove("action-cleanup-failure", intent.idempotencyKey);
    } catch (error) {
      if (
        await this.options.records.get("action-cleanup-failure", intent.idempotencyKey) ===
          undefined
      ) {
        await this.options.records.put("action-cleanup-failure", intent.idempotencyKey, {
          schemaVersion: 1,
          intent,
          message: safeCleanupMessage(error),
        });
      }
    }
  }

  public async execute(
    context: ActionContext,
    intent: EffectIntent<K, Readonly<Record<string, unknown>>>,
  ): Promise<O> {
    const input = await this.bound(intent);
    const existing = await this.completed(intent);
    if (existing !== undefined) {
      await this.afterCompleted(input, existing, intent);
      return existing;
    }
    const rawOutput = this.options.validateOutput(
      await this.options.handler.execute(context, this.delegated(intent, input)),
    );
    const output = this.options.validateOutput(
      this.options.binder.mapOutput?.(input, rawOutput) ?? rawOutput,
    );
    const persisted = this.options.validateOutput(await this.options.records.put(
      "action-completed",
      intent.idempotencyKey,
      output as unknown as JsonValue,
    ));
    await this.afterCompleted(input, persisted, intent);
    return persisted;
  }

  public async reconcile(
    context: ActionContext,
    intent: EffectIntent<K, Readonly<Record<string, unknown>>>,
  ): Promise<ReconcileResult<O>> {
    const existingInput = await this.options.records.get<unknown>(
      "bound-input",
      intent.idempotencyKey,
    );
    if (existingInput === undefined) return { status: "not_found" };
    const input = this.options.validateInput(existingInput);
    const completed = await this.completed(intent);
    if (completed !== undefined) {
      await this.afterCompleted(input, completed, intent);
      return { status: "observed", output: completed };
    }
    const result = await this.options.handler.reconcile(
      context,
      this.delegated(intent, input),
    );
    if (result.status !== "observed") return result;
    const rawOutput = this.options.validateOutput(result.output);
    const output = this.options.validateOutput(
      this.options.binder.mapOutput?.(input, rawOutput) ?? rawOutput,
    );
    await this.options.records.put(
      "action-completed",
      intent.idempotencyKey,
      output as unknown as JsonValue,
    );
    await this.afterCompleted(input, output, intent);
    return { status: "observed", output };
  }
}
