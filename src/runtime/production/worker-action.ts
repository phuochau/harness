import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "../../actions/types.js";
import type { JsonValue } from "../../contracts/common.js";
import {
  validateWorkerResult,
  type WorkerResult,
} from "../../contracts/worker-result.js";
import type { DurableRecordStore } from "./records.js";

export type ProductionWorkerKind = "worker.execute" | "worker.review";
export type ProductionWorkerInput = Readonly<Record<string, unknown>>;
export type PreparedWorkerAttempt = Readonly<Record<string, JsonValue>>;

export interface ProductionWorkerRuntime {
  prepare(
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<PreparedWorkerAttempt>;
  execute(
    prepared: PreparedWorkerAttempt,
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<WorkerResult>;
  reconcile(
    prepared: PreparedWorkerAttempt,
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<ReconcileResult<WorkerResult>>;
}

export interface DurableWorkerActionOptions {
  readonly records: DurableRecordStore;
  readonly runtime: ProductionWorkerRuntime;
}

export class DurableWorkerAction<K extends ProductionWorkerKind>
  implements ActionHandler<K, ProductionWorkerInput, WorkerResult>
{
  public constructor(
    public readonly kind: K,
    private readonly options: DurableWorkerActionOptions,
  ) {}

  public recovery(_input: ProductionWorkerInput): RecoveryClass {
    return "non_retryable";
  }

  private async completed(
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<WorkerResult | undefined> {
    const value = await this.options.records.get<unknown>(
      "worker-completed",
      intent.idempotencyKey,
    );
    return value === undefined ? undefined : validateWorkerResult(value);
  }

  private async prepared(
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<PreparedWorkerAttempt | undefined> {
    return this.options.records.get<PreparedWorkerAttempt>(
      "worker-prepared",
      intent.idempotencyKey,
    );
  }

  public async execute(
    _context: ActionContext,
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<WorkerResult> {
    const completed = await this.completed(intent);
    if (completed !== undefined) return completed;
    const prepared = await this.prepared(intent) ?? await this.options.records.put(
      "worker-prepared",
      intent.idempotencyKey,
      await this.options.runtime.prepare(intent),
    );
    const output = validateWorkerResult(
      await this.options.runtime.execute(prepared, intent),
    );
    return this.options.records.put(
      "worker-completed",
      intent.idempotencyKey,
      output,
    );
  }

  public async reconcile(
    _context: ActionContext,
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<ReconcileResult<WorkerResult>> {
    const completed = await this.completed(intent);
    if (completed !== undefined) return { status: "observed", output: completed };
    const prepared = await this.prepared(intent);
    if (prepared === undefined) return { status: "not_found" };
    const result = await this.options.runtime.reconcile(prepared, intent);
    if (result.status !== "observed") return result;
    const output = validateWorkerResult(result.output);
    await this.options.records.put("worker-completed", intent.idempotencyKey, output);
    return { status: "observed", output };
  }
}
