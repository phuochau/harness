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
  afterCompleted?(
    prepared: PreparedWorkerAttempt,
    output: WorkerResult,
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<void>;
  abort?(
    prepared: PreparedWorkerAttempt,
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<void>;
}

export class WorkerCancelledError extends Error {
  public readonly code = "WORKER_CANCELLED";

  public constructor(public readonly intentKey: string) {
    super(`worker attempt cancelled: ${intentKey}`);
  }
}

export class WorkerCleanupDeferredError extends Error {
  public readonly code = "WORKER_CLEANUP_DEFERRED";
  public readonly deferred = true;

  public constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

interface WorkerCancellationInput extends Readonly<Record<string, unknown>> {
  readonly originalIntent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>;
}

interface WorkerCancellationOutput {
  readonly cancelledIntentKey: string;
}

export interface DurableWorkerActionOptions {
  readonly records: DurableRecordStore;
  readonly runtime: ProductionWorkerRuntime;
}

function safeCleanupMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|password|secret|authorization)=\S+/gi, "$1=[REDACTED]");
}

export class DurableWorkerAction<K extends ProductionWorkerKind>
  implements ActionHandler<K, ProductionWorkerInput, WorkerResult>
{
  public constructor(
    public readonly kind: K,
    private readonly options: DurableWorkerActionOptions,
  ) {}

  public recovery(_input: ProductionWorkerInput): RecoveryClass {
    return "reconcilable";
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

  private async cancelled(intent: EffectIntent<K, ProductionWorkerInput>): Promise<boolean> {
    return (await this.options.records.get(
      "worker-cancelled",
      intent.idempotencyKey,
    )) !== undefined;
  }

  private async throwIfCancelled(
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<void> {
    if (!(await this.cancelled(intent))) return;
    throw new WorkerCancelledError(intent.idempotencyKey);
  }

  private async afterCompleted(
    prepared: PreparedWorkerAttempt,
    output: WorkerResult,
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<void> {
    try {
      await this.options.runtime.afterCompleted?.(prepared, output, intent);
      await this.options.records.remove("worker-cleanup-failure", intent.idempotencyKey);
    } catch (error) {
      if (
        await this.options.records.get("worker-cleanup-failure", intent.idempotencyKey) ===
          undefined
      ) {
        await this.options.records.put("worker-cleanup-failure", intent.idempotencyKey, {
          schemaVersion: 1,
          intent,
          message: safeCleanupMessage(error),
        });
      }
      throw new WorkerCleanupDeferredError(
        `worker completion is durable but cleanup is pending: ${safeCleanupMessage(error)}`,
        error,
      );
    }
  }

  private async afterFailed(
    prepared: PreparedWorkerAttempt,
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<void> {
    if (this.options.runtime.abort === undefined) return;
    try {
      await this.options.runtime.abort(prepared, intent);
      await this.options.records.remove("worker-abort-failure", intent.idempotencyKey);
    } catch (error) {
      await this.options.records.put("worker-abort-failure", intent.idempotencyKey, {
        schemaVersion: 1,
        intent,
        prepared,
        message: safeCleanupMessage(error),
      });
      throw new WorkerCleanupDeferredError(
        `failed worker cleanup is pending: ${safeCleanupMessage(error)}`,
        error,
      );
    }
  }

  public async execute(
    _context: ActionContext,
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<WorkerResult> {
    const completed = await this.completed(intent);
    if (completed !== undefined) {
      const prepared = await this.prepared(intent);
      if (prepared !== undefined) {
        await this.afterCompleted(prepared, completed, intent);
      }
      return completed;
    }
    await this.throwIfCancelled(intent);
    const prepared = await this.prepared(intent) ?? await this.options.records.put(
      "worker-prepared",
      intent.idempotencyKey,
      await this.options.runtime.prepare(intent),
    );
    await this.throwIfCancelled(intent);
    let output: WorkerResult;
    try {
      output = validateWorkerResult(
        await this.options.runtime.execute(prepared, intent),
      );
    } catch (error) {
      if (!(await this.cancelled(intent))) {
        await this.afterFailed(prepared, intent);
      }
      throw error;
    }
    await this.throwIfCancelled(intent);
    const persisted = await this.options.records.put(
      "worker-completed",
      intent.idempotencyKey,
      output,
    );
    await this.afterCompleted(prepared, persisted, intent);
    return persisted;
  }

  public async reconcile(
    _context: ActionContext,
    intent: EffectIntent<K, ProductionWorkerInput>,
  ): Promise<ReconcileResult<WorkerResult>> {
    const completed = await this.completed(intent);
    if (completed !== undefined) {
      const prepared = await this.prepared(intent);
      if (prepared !== undefined) {
        await this.afterCompleted(prepared, completed, intent);
      }
      return { status: "observed", output: completed };
    }
    const prepared = await this.prepared(intent);
    await this.throwIfCancelled(intent);
    if (prepared === undefined) return { status: "not_found" };
    let result: ReconcileResult<WorkerResult>;
    try {
      result = await this.options.runtime.reconcile(prepared, intent);
    } catch (error) {
      await this.afterFailed(prepared, intent);
      throw error;
    }
    if (result.status !== "observed") return result;
    const output = validateWorkerResult(result.output);
    await this.options.records.put("worker-completed", intent.idempotencyKey, output);
    await this.afterCompleted(prepared, output, intent);
    return { status: "observed", output };
  }
}

export class DurableWorkerCancelAction
  implements ActionHandler<"worker.cancel", WorkerCancellationInput, WorkerCancellationOutput>
{
  public readonly kind = "worker.cancel" as const;
  private readonly inFlight = new Map<string, Promise<WorkerCancellationOutput>>();

  public constructor(private readonly options: DurableWorkerActionOptions) {}

  public recovery(_input: WorkerCancellationInput): RecoveryClass {
    return "reconcilable";
  }

  private async performCancel(
    input: WorkerCancellationInput,
  ): Promise<WorkerCancellationOutput> {
    const original = input.originalIntent;
    await this.options.records.put("worker-cancelled", original.idempotencyKey, {
      schemaVersion: 1,
      originalIntentKey: original.idempotencyKey,
    });
    if (
      await this.options.records.get("worker-aborted", original.idempotencyKey) !==
        undefined
    ) {
      return { cancelledIntentKey: original.idempotencyKey };
    }
    if (
      await this.options.records.get("worker-completed", original.idempotencyKey) !==
        undefined
    ) {
      return { cancelledIntentKey: original.idempotencyKey };
    }
    const prepared = await this.options.records.get<PreparedWorkerAttempt>(
      "worker-prepared",
      original.idempotencyKey,
    );
    if (prepared !== undefined) {
      if (this.options.runtime.abort === undefined) {
        throw new Error("worker runtime does not support cancellation");
      }
      try {
        await this.options.runtime.abort(prepared, original);
        await this.options.records.remove(
          "worker-abort-failure",
          original.idempotencyKey,
        );
      } catch (error) {
        await this.options.records.put(
          "worker-abort-failure",
          original.idempotencyKey,
          {
            schemaVersion: 1,
            intent: original,
            prepared,
            message: safeCleanupMessage(error),
          },
        );
        throw new WorkerCleanupDeferredError(
          `worker cancellation cleanup is pending: ${safeCleanupMessage(error)}`,
          error,
        );
      }
    }
    await this.options.records.put("worker-aborted", original.idempotencyKey, {
      schemaVersion: 1,
      originalIntentKey: original.idempotencyKey,
    });
    return { cancelledIntentKey: original.idempotencyKey };
  }

  private cancel(input: WorkerCancellationInput): Promise<WorkerCancellationOutput> {
    const key = input.originalIntent.idempotencyKey;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const operation = this.performCancel(input).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  public execute(
    _context: ActionContext,
    intent: EffectIntent<"worker.cancel", WorkerCancellationInput>,
  ): Promise<WorkerCancellationOutput> {
    return this.cancel(intent.input);
  }

  public async reconcile(
    _context: ActionContext,
    intent: EffectIntent<"worker.cancel", WorkerCancellationInput>,
  ): Promise<ReconcileResult<WorkerCancellationOutput>> {
    const marker = await this.options.records.get(
      "worker-cancelled",
      intent.input.originalIntent.idempotencyKey,
    );
    if (marker === undefined) return { status: "not_found" };
    return { status: "observed", output: await this.cancel(intent.input) };
  }
}
