import type { EffectIntent } from "./actions/types.js";
import type { Clock } from "./actions/types.js";
import type { JsonValue } from "./contracts/common.js";
import type { ControllerCommand } from "./contracts/controller-command.js";
import {
  DurableCommandProcessor,
  type CommandDeriver,
} from "./controller/command-source.js";
import { ControllerCommandQueue } from "./controller/command-queue.js";
import { HarnessController } from "./controller/controller.js";
import { reduceEvent } from "./core/reducer.js";
import { initialRunState, type RunState } from "./core/state.js";
import { canonicalJson } from "./shared/canonical-json.js";
import type { Journal } from "./state/journal.js";
import type { LeaseHandle } from "./state/lease.js";

export interface DurableEffectPort {
  runFresh(intent: EffectIntent<string, JsonValue>): Promise<unknown>;
  recover(intent: EffectIntent<string, JsonValue>): Promise<unknown>;
}

export interface DurableHarnessPorts {
  readonly runId: string;
  readonly workflowRevision: string;
  readonly journal: Journal;
  readonly lease: LeaseHandle;
  readonly clock: Clock;
  readonly derive: CommandDeriver;
  readonly effects: DurableEffectPort;
}

export interface DurableHarnessSystem {
  readonly controller: HarnessController;
  readState(): Promise<RunState>;
  recover(): Promise<void>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function safeEvidence(error: unknown): readonly string[] {
  const message = error instanceof Error ? error.message : String(error);
  return [
    message
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(/\b(token|password|secret|authorization)=\S+/gi, "$1=[REDACTED]"),
  ];
}

function entityFor(intent: EffectIntent<string, JsonValue>, runId: string): string {
  if (
    typeof intent.input === "object" &&
    intent.input !== null &&
    !Array.isArray(intent.input)
  ) {
    const input = intent.input as Record<string, JsonValue>;
    if (typeof input.entityId === "string") return input.entityId;
    if (typeof input.jobId === "string") return input.jobId;
  }
  return `run:${runId}`;
}

function effectResultCommand(
  runId: string,
  intent: EffectIntent<string, JsonValue>,
  outcome:
    | { readonly status: "observed"; readonly output: unknown }
    | {
        readonly status: "failed";
        readonly code: string;
        readonly evidence: readonly string[];
      },
): ControllerCommand {
  return {
    schemaVersion: 1,
    source: "controller",
    kind: "effect_result",
    idempotencyKey: `effect-result:${intent.idempotencyKey}`,
    payload: {
      status: outcome.status,
      action: intent.action,
      intentKey: intent.idempotencyKey,
      entityId: entityFor(intent, runId),
      ...(outcome.status === "observed"
        ? { output: jsonValue(outcome.output) }
        : { code: outcome.code, evidence: [...outcome.evidence] }),
    },
  };
}

export function createHarnessSystem(
  ports: DurableHarnessPorts,
): DurableHarnessSystem {
  const dispatches = new Set<Promise<void>>();
  const recovering = new Set<string>();
  let disposed = false;
  let controller: HarnessController;

  const readState = async (): Promise<RunState> => {
    let state = initialRunState(ports.runId, ports.workflowRevision);
    for (const event of await ports.journal.read()) state = reduceEvent(state, event);
    return state;
  };

  const dispatch = (
    intent: EffectIntent<string, JsonValue>,
    mode: "fresh" | "recover",
  ): void => {
    if (recovering.has(intent.idempotencyKey)) return;
    recovering.add(intent.idempotencyKey);
    const operation = (async () => {
      let command: ControllerCommand;
      try {
        const output = mode === "fresh"
          ? await ports.effects.runFresh(intent)
          : await ports.effects.recover(intent);
        command = effectResultCommand(
          ports.runId,
          intent,
          { status: "observed", output },
        );
      } catch (error) {
        command = effectResultCommand(
          ports.runId,
          intent,
          {
            status: "failed",
            code:
              typeof error === "object" &&
              error !== null &&
              typeof (error as { code?: unknown }).code === "string"
                ? (error as { code: string }).code
                : "EFFECT_EXECUTION_FAILED",
            evidence: safeEvidence(error),
          },
        );
      }
      try {
        await controller.enqueue(command);
      } finally {
        recovering.delete(intent.idempotencyKey);
      }
    })();
    dispatches.add(operation);
    void operation.then(
      () => dispatches.delete(operation),
      () => dispatches.delete(operation),
    );
  };

  const processor = new DurableCommandProcessor({
    runId: ports.runId,
    workflowRevision: ports.workflowRevision,
    journal: ports.journal,
    lease: ports.lease,
    clock: ports.clock,
    derive: ports.derive,
    hooks: {
      afterFreshEffectIntent: (intent) => dispatch(intent, "fresh"),
    },
  });
  controller = new HarnessController(new ControllerCommandQueue(processor));

  const drain = async (): Promise<void> => {
    while (true) {
      await controller.drain();
      const active = [...dispatches];
      if (active.length === 0) return;
      await Promise.all(active);
    }
  };

  return Object.freeze({
    controller,
    readState,
    async recover() {
      if (disposed) throw new Error("durable harness system is disposed");
      await controller.recoverPending();
      const state = await readState();
      for (const intent of Object.values(state.outstandingEffects)) {
        dispatch(intent as EffectIntent<string, JsonValue>, "recover");
      }
    },
    drain,
    async dispose() {
      if (disposed) return;
      await drain();
      disposed = true;
      await ports.lease.release();
    },
  });
}
