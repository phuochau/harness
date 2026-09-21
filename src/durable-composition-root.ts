import type { EffectIntent } from "./actions/types.js";
import type { Clock } from "./actions/types.js";
import type { JsonValue } from "./contracts/common.js";
import type { ControllerCommand } from "./contracts/controller-command.js";
import type { DecisionEventDraft } from "./contracts/events.js";
import {
  DurableCommandProcessor,
  type AcceptedCommandRecord,
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
  readonly beforeLeaseRelease?: () => Promise<void>;
  readonly lifecycle?: {
    observed(
      intent: EffectIntent<string, JsonValue>,
      output: unknown,
    ): readonly DecisionEventDraft[];
    failed?(
      intent: EffectIntent<string, JsonValue>,
      error: unknown,
    ): readonly DecisionEventDraft[];
  };
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

function isDeferredEffect(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { deferred?: unknown }).deferred === true;
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
    | {
        readonly status: "observed";
        readonly output: unknown;
        readonly lifecycle: readonly DecisionEventDraft[];
      }
    | {
        readonly status: "failed";
        readonly code: string;
        readonly evidence: readonly string[];
        readonly lifecycle: readonly DecisionEventDraft[];
      },
): ControllerCommand {
  return {
    schemaVersion: 1,
    source: "process",
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
      lifecycle: jsonValue(outcome.lifecycle),
    },
  };
}

function record(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("effect result payload must be an object");
  }
  return value;
}

function requiredString(
  value: Readonly<Record<string, JsonValue>>,
  key: string,
): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`effect result payload requires ${key}`);
  }
  return result;
}

function effectResultDecision(
  accepted: AcceptedCommandRecord,
): { readonly events: readonly DecisionEventDraft[]; readonly effects: readonly [] } {
  const payload = record(accepted.command.payload);
  const status = requiredString(payload, "status");
  const action = requiredString(payload, "action");
  const intentKey = requiredString(payload, "intentKey");
  const entityId = requiredString(payload, "entityId");
  const lifecycleValue = payload.lifecycle;
  if (!Array.isArray(lifecycleValue)) {
    throw new Error("effect result payload requires lifecycle events");
  }
  const lifecycle = lifecycleValue as unknown as DecisionEventDraft[];
  if (status === "observed") {
    return {
      events: [{
        eventType: "effect.observed",
        entityId,
        idempotencyKey: `observed:${intentKey}`,
        payload: { action, intentKey, output: payload.output ?? null },
      }, ...lifecycle],
      effects: [],
    };
  }
  if (status !== "failed") throw new Error(`unknown effect result status ${status}`);
  const evidence = payload.evidence;
  if (!Array.isArray(evidence) || evidence.some((item) => typeof item !== "string")) {
    throw new Error("failed effect result requires string evidence");
  }
  return {
    events: [{
      eventType: "effect.failed",
      entityId,
      idempotencyKey: `failed:${intentKey}`,
      payload: {
        action,
        intentKey,
        code: requiredString(payload, "code"),
        evidence,
      },
    }, ...lifecycle],
    effects: [],
  };
}

export function createHarnessSystem(
  ports: DurableHarnessPorts,
): DurableHarnessSystem {
  const dispatches = new Set<Promise<void>>();
  const recovering = new Set<string>();
  let activityRevision = 0;
  let dispatchFailure: unknown;
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
    activityRevision += 1;
    const operation = (async () => {
      try {
        let output: unknown;
        try {
          output = mode === "fresh"
            ? await ports.effects.runFresh(intent)
            : await ports.effects.recover(intent);
        } catch (error) {
          // Deferred effects (for example a human approval requested during a
          // headless recovery) remain outstanding. An interactive controller
          // can reconcile the same durable intent later without an extra retry.
          if (isDeferredEffect(error)) return;
          const defaultFailure: DecisionEventDraft = {
            eventType: "job.failed",
            entityId: entityFor(intent, ports.runId),
            idempotencyKey: `job-failed:${intent.idempotencyKey}`,
            payload: {
              reason: error instanceof Error ? error.message : String(error),
            },
          };
          await controller.enqueue(effectResultCommand(
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
              lifecycle: ports.lifecycle?.failed?.(intent, error) ?? [defaultFailure],
            },
          ));
          await controller.enqueue({
            schemaVersion: 1,
            source: "timer",
            kind: "tick",
            idempotencyKey: `wake-after-effect:${intent.idempotencyKey}`,
            payload: { reason: "effect_result", intentKey: intent.idempotencyKey },
          });
          return;
        }

        // Mapping successful external output into lifecycle evidence is deliberately
        // outside the execution catch. If the mapper rejects the output, the durable
        // intent remains outstanding so recovery can reconcile it safely.
        await controller.enqueue(effectResultCommand(
          ports.runId,
          intent,
          {
            status: "observed",
            output,
            lifecycle: ports.lifecycle?.observed(intent, output) ?? [],
          },
        ));
        await controller.enqueue({
          schemaVersion: 1,
          source: "timer",
          kind: "tick",
          idempotencyKey: `wake-after-effect:${intent.idempotencyKey}`,
          payload: { reason: "effect_result", intentKey: intent.idempotencyKey },
        });
      } finally {
        recovering.delete(intent.idempotencyKey);
      }
    })();
    dispatches.add(operation);
    void operation.then(
      () => dispatches.delete(operation),
      (error) => {
        dispatchFailure ??= error;
        dispatches.delete(operation);
      },
    );
  };

  const processor = new DurableCommandProcessor({
    runId: ports.runId,
    workflowRevision: ports.workflowRevision,
    journal: ports.journal,
    lease: ports.lease,
    clock: ports.clock,
    derive: (state, accepted) =>
      accepted.command.source === "process" &&
      accepted.command.kind === "effect_result"
        ? effectResultDecision(accepted)
        : ports.derive(state, accepted),
    hooks: {
      afterFreshEffectIntent: (intent) => dispatch(intent, "fresh"),
    },
  });
  controller = new HarnessController(new ControllerCommandQueue(processor));

  const drain = async (): Promise<void> => {
    while (true) {
      if (dispatchFailure !== undefined) {
        const failure = dispatchFailure;
        dispatchFailure = undefined;
        throw failure;
      }
      const observedRevision = activityRevision;
      await controller.drain();
      const active = [...dispatches];
      await Promise.allSettled(active);
      await controller.drain();
      if (dispatchFailure !== undefined) {
        const failure = dispatchFailure;
        dispatchFailure = undefined;
        throw failure;
      }
      if (
        dispatches.size === 0 &&
        activityRevision === observedRevision
      ) {
        return;
      }
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
      try {
        await drain();
        await ports.beforeLeaseRelease?.();
      } finally {
        disposed = true;
        await ports.lease.release();
      }
    },
  });
}
