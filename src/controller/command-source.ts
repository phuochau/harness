import type { EffectIntent } from "../actions/types.js";
import type { Clock } from "../actions/types.js";
import type { JsonValue } from "../contracts/common.js";
import {
  validateControllerCommand,
  type ControllerCommand,
} from "../contracts/controller-command.js";
import type {
  CommandDecisionBatch,
  DecisionEventDraft,
  HarnessEvent,
} from "../contracts/events.js";
import { decisionBatchHash, reduceEvent } from "../core/reducer.js";
import { initialRunState, type RunState } from "../core/state.js";
import { Journal, type EventInput } from "../state/journal.js";
import type { LeaseHandle } from "../state/lease.js";
import { reserveEffectLanes } from "./effect-lanes.js";
import type {
  AcceptedCommand,
  CommandQueueProcessor,
  CommandResult,
} from "./command-queue.js";

export interface AcceptedCommandRecord {
  readonly command: ControllerCommand;
  readonly acceptedAt: string;
  readonly acceptedSequence: number;
  readonly stateRevision: number;
}

export interface CommandDecision {
  readonly events: readonly DecisionEventDraft[];
  readonly effects: readonly EffectIntent<string, JsonValue>[];
}

export type CommandDeriver = (
  state: RunState,
  accepted: AcceptedCommandRecord,
) => CommandDecision;

export interface CommandProcessorHooks {
  afterAppend?(event: HarnessEvent): void | Promise<void>;
  afterBatchMember?(count: number, event: HarnessEvent): void | Promise<void>;
  afterFreshEffectIntent?(intent: EffectIntent<string, JsonValue>): void;
}

export interface DurableCommandProcessorOptions {
  readonly runId: string;
  readonly workflowRevision: string;
  readonly journal: Journal;
  readonly lease: LeaseHandle;
  readonly clock: Clock;
  readonly derive: CommandDeriver;
  readonly hooks?: CommandProcessorHooks;
}

export class DurableCommandProcessor
  implements CommandQueueProcessor<ControllerCommand>
{
  public constructor(private readonly options: DurableCommandProcessorOptions) {}

  private async state(): Promise<RunState> {
    let state = initialRunState(
      this.options.runId,
      this.options.workflowRevision,
    );
    for (const event of await this.options.journal.read()) {
      state = reduceEvent(state, event);
    }
    return state;
  }

  private async append(input: EventInput) {
    const result = await this.options.journal.append(input, this.options.lease);
    if (result.inserted) await this.options.hooks?.afterAppend?.(result.event);
    return result;
  }

  public async accept(commandValue: ControllerCommand): Promise<AcceptedCommand> {
    const command = validateControllerCommand(structuredClone(commandValue));
    const result = await this.append({
      schemaVersion: 1,
      timestamp: this.options.clock.now().toISOString(),
      runId: this.options.runId,
      entityId: `run:${this.options.runId}`,
      idempotencyKey: `command-received:${command.idempotencyKey}`,
      eventType: "controller.command_received",
      payload: { command } as JsonValue,
    });
    return {
      commandKey:
        result.event.eventType === "controller.command_received"
          ? result.event.payload.command.idempotencyKey
          : command.idempotencyKey,
    };
  }

  public async pendingCommandKeysInSequenceOrder(): Promise<readonly string[]> {
    const state = await this.state();
    return Object.entries(state.pendingCommands)
      .sort(([, left], [, right]) => left.receivedSequence - right.receivedSequence)
      .map(([key]) => key);
  }

  private async appendDecision(
    state: RunState,
    commandKey: string,
  ): Promise<CommandDecisionBatch> {
    const pending = state.pendingCommands[commandKey];
    if (!pending) throw new Error(`unknown pending command ${commandKey}`);
    const accepted: AcceptedCommandRecord = {
      command: pending.command,
      acceptedAt: pending.receivedAt,
      acceptedSequence: pending.receivedSequence,
      stateRevision: pending.receivedSequence,
    };
    const decision = this.options.derive(state, accepted);
    const effects = reserveEffectLanes(state, decision.effects);
    const events = decision.events.map((draft, index) => ({
      ...draft,
      idempotencyKey: `decision-member:${commandKey}:${index}:${draft.idempotencyKey}`,
    }));
    const unsigned = {
      commandKey,
      acceptedSequence: accepted.acceptedSequence,
      acceptedAt: accepted.acceptedAt,
      stateRevision: accepted.stateRevision,
      events,
      effects: [...effects],
    };
    const batch: CommandDecisionBatch = {
      ...unsigned,
      decisionHash: decisionBatchHash(unsigned),
    };
    await this.append({
      schemaVersion: 1,
      timestamp: this.options.clock.now().toISOString(),
      runId: this.options.runId,
      entityId: `run:${this.options.runId}`,
      idempotencyKey: `command-decided:${commandKey}`,
      eventType: "controller.command_decided",
      payload: batch as JsonValue,
    });
    return batch;
  }

  private memberInput(
    commandKey: string,
    index: number,
    draft: DecisionEventDraft,
  ): EventInput {
    return {
      schemaVersion: 1,
      timestamp: this.options.clock.now().toISOString(),
      runId: this.options.runId,
      entityId: draft.entityId,
      idempotencyKey: draft.idempotencyKey,
      eventType: draft.eventType as HarnessEvent["eventType"],
      payload: draft.payload,
    };
  }

  private effectInput(
    commandKey: string,
    index: number,
    effect: EffectIntent<string, JsonValue>,
  ): EventInput {
    const entityId =
      effect.input &&
      typeof effect.input === "object" &&
      !Array.isArray(effect.input) &&
      typeof effect.input.entityId === "string"
        ? effect.input.entityId
        : `run:${this.options.runId}`;
    return {
      schemaVersion: 1,
      timestamp: this.options.clock.now().toISOString(),
      runId: this.options.runId,
      entityId,
      idempotencyKey: `decision-effect:${commandKey}:${index}:${effect.idempotencyKey}`,
      eventType: "effect.intent",
      payload: effect as unknown as JsonValue,
    };
  }

  public async processReceived(commandKey: string): Promise<CommandResult> {
    let state = await this.state();
    if (state.processedCommands[commandKey] !== undefined) {
      return { commandKey, stateRevision: state.lastSequence };
    }
    if (!state.pendingCommands[commandKey]) {
      throw new Error(`unknown received command ${commandKey}`);
    }
    let batch = state.pendingDecisions[commandKey]?.batch;
    if (!batch) batch = await this.appendDecision(state, commandKey);

    let memberCount = 0;
    for (const [index, draft] of batch.events.entries()) {
      const result = await this.append(this.memberInput(commandKey, index, draft));
      memberCount += 1;
      if (result.inserted) {
        await this.options.hooks?.afterBatchMember?.(memberCount, result.event);
      }
    }
    const freshEffects: EffectIntent<string, JsonValue>[] = [];
    for (const [index, effect] of batch.effects.entries()) {
      const result = await this.append(
        this.effectInput(commandKey, batch.events.length + index, effect),
      );
      memberCount += 1;
      if (result.inserted) {
        freshEffects.push(effect);
        await this.options.hooks?.afterBatchMember?.(memberCount, result.event);
      }
    }
    await this.append({
      schemaVersion: 1,
      timestamp: this.options.clock.now().toISOString(),
      runId: this.options.runId,
      entityId: `run:${this.options.runId}`,
      idempotencyKey: `command-processed:${commandKey}`,
      eventType: "controller.command_processed",
      payload: { source: "controller", commandKey },
    });
    for (const effect of freshEffects) {
      this.options.hooks?.afterFreshEffectIntent?.(effect);
    }
    state = await this.state();
    return { commandKey, stateRevision: state.lastSequence };
  }
}
