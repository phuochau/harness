import type {
  SchedulerAction,
  SchedulerActionDispatcher,
} from "../../src/core/scheduler.js";

export type CrashBoundary = "after-intent" | "after-effect";

export interface FakeSchedulerMetrics {
  readonly maxConcurrentImplementations: number;
  overlapsInvolving(taskId: string): readonly string[];
}

export class InjectedControllerCrash extends Error {}

export class FakeActionRegistry implements SchedulerActionDispatcher {
  private readonly externalResults = new Map<string, unknown>();
  private readonly executions = new Map<string, number>();
  private readonly observations = new Map<string, number>();
  private readonly kinds = new Set<string>();
  private readonly activeImplementations = new Set<string>();
  private readonly overlaps = new Map<string, Set<string>>();
  private crashed = false;
  private maxConcurrent = 0;

  public constructor(
    private readonly results: Readonly<Record<string, unknown>>,
    private readonly crashAt?: CrashBoundary,
  ) {}

  private key(action: SchedulerAction): string {
    return `${action.kind}:${action.jobId}:${action.attempt}`;
  }

  private recordOverlap(taskId: string): void {
    for (const active of this.activeImplementations) {
      (this.overlaps.get(taskId) ?? this.overlaps.set(taskId, new Set()).get(taskId)!).add(active);
      (this.overlaps.get(active) ?? this.overlaps.set(active, new Set()).get(active)!).add(taskId);
    }
  }

  private async perform(action: SchedulerAction): Promise<unknown> {
    const key = this.key(action);
    if (this.observations.has(key)) return this.externalResults.get(key);
    this.kinds.add(action.kind);
    if (!this.externalResults.has(key)) {
      if (this.crashAt === "after-intent" && !this.crashed) {
        this.crashed = true;
        throw new InjectedControllerCrash("injected crash after intent");
      }
      this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
      if (action.kind === "worker.execute" && action.taskId) {
        this.recordOverlap(action.taskId);
        this.activeImplementations.add(action.taskId);
        this.maxConcurrent = Math.max(
          this.maxConcurrent,
          this.activeImplementations.size,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        this.activeImplementations.delete(action.taskId);
      } else {
        await Promise.resolve();
      }
      this.externalResults.set(key, this.results[action.kind] ?? { ok: true });
      if (this.crashAt === "after-effect" && !this.crashed) {
        this.crashed = true;
        throw new InjectedControllerCrash("injected crash after effect");
      }
    }
    this.observations.set(key, (this.observations.get(key) ?? 0) + 1);
    return this.externalResults.get(key);
  }

  public execute(action: SchedulerAction): Promise<unknown> {
    return this.perform(action);
  }

  public async recover(action: SchedulerAction): Promise<unknown> {
    const key = this.key(action);
    if (!this.externalResults.has(key)) {
      const previous = this.crashed;
      this.crashed = true;
      try {
        return await this.perform(action);
      } finally {
        this.crashed = previous || true;
      }
    }
    if (!this.observations.has(key)) {
      this.observations.set(key, 1);
    }
    return this.externalResults.get(key);
  }

  public executeCount(kind: string, identity: string): number {
    return this.executions.get(`${kind}:${identity}`) ?? 0;
  }

  public observationCount(kind: string, identity: string): number {
    return this.observations.get(`${kind}:${identity}`) ?? 0;
  }

  public actionKinds(): string[] {
    return [...this.kinds];
  }

  public get metrics(): FakeSchedulerMetrics {
    return {
      maxConcurrentImplementations: this.maxConcurrent,
      overlapsInvolving: (taskId) => [...(this.overlaps.get(taskId) ?? [])].sort(),
    };
  }
}
