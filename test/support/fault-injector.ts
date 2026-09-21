import { canonicalJson } from "../../src/shared/canonical-json.js";
import { sha256 } from "../../src/shared/sha256.js";

export const crashBoundaries = [
  "before-intent",
  "after-intent",
  "after-effect",
  "before-observation",
  "after-observation",
  "after-herdr-prompt-send",
  "during-snapshot",
  "after-worker-result",
  "after-multi-commit-integration",
  "after-atomic-task-finalize",
  "after-final-review",
  "after-push",
  "after-pr-create",
] as const;

export type FaultBoundary = (typeof crashBoundaries)[number];

export class InjectedFault extends Error {}

export class FaultInjector {
  private fired = false;

  public constructor(private readonly target: FaultBoundary) {}

  public checkpoint(boundary: FaultBoundary): void {
    if (!this.fired && boundary === this.target) {
      this.fired = true;
      throw new InjectedFault(`injected fault at ${boundary}`);
    }
  }
}

interface LedgerEvent {
  readonly sequence: number;
  readonly type: "intent" | "observed";
  readonly key: string;
  readonly previousHash: string;
  readonly hash: string;
}

export class CrashSafeEffectHarness {
  private readonly injector: FaultInjector;
  private readonly events: LedgerEvent[] = [];
  private readonly externalExecutions = new Map<string, number>();
  private readonly key = "effect:feature:1";

  public constructor(boundary: FaultBoundary) {
    this.injector = new FaultInjector(boundary);
  }

  private append(type: LedgerEvent["type"]): void {
    if (this.events.some((event) => event.type === type && event.key === this.key)) return;
    const unsigned = {
      sequence: this.events.length + 1,
      type,
      key: this.key,
      previousHash: this.events.at(-1)?.hash ?? `sha256:${"0".repeat(64)}`,
    };
    this.events.push({ ...unsigned, hash: sha256(canonicalJson(unsigned)) });
  }

  private checkpointAll(boundaries: readonly FaultBoundary[]): void {
    for (const boundary of boundaries) this.injector.checkpoint(boundary);
  }

  private runOnce(): void {
    const observed = this.events.some((event) => event.type === "observed");
    if (observed) return;
    const intended = this.events.some((event) => event.type === "intent");
    if (!intended) {
      this.injector.checkpoint("before-intent");
      this.append("intent");
      this.injector.checkpoint("after-intent");
    }
    if (!this.externalExecutions.has(this.key)) {
      this.externalExecutions.set(this.key, 1);
      this.checkpointAll([
        "after-effect",
        "after-herdr-prompt-send",
        "after-worker-result",
        "after-multi-commit-integration",
        "after-atomic-task-finalize",
        "after-final-review",
        "after-push",
        "after-pr-create",
      ]);
    }
    this.injector.checkpoint("before-observation");
    this.append("observed");
    this.injector.checkpoint("after-observation");
    this.injector.checkpoint("during-snapshot");
  }

  public crashAndRestart(): void {
    try {
      this.runOnce();
    } catch (error) {
      if (!(error instanceof InjectedFault)) throw error;
    }
    this.runOnce();
  }

  public duplicateEffectKeys(): readonly string[] {
    return [...this.externalExecutions]
      .filter(([, count]) => count > 1)
      .map(([key]) => key);
  }

  public eventChainValid(): boolean {
    let previousHash = `sha256:${"0".repeat(64)}`;
    for (const event of this.events) {
      const { hash, ...unsigned } = event;
      if (
        unsigned.previousHash !== previousHash ||
        hash !== sha256(canonicalJson(unsigned))
      ) return false;
      previousHash = hash;
    }
    return this.events.filter((event) => event.type === "intent").length === 1 &&
      this.events.filter((event) => event.type === "observed").length === 1;
  }
}
