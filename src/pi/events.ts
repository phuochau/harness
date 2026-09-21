import type { JsonValue } from "../contracts/common.js";
import type { ControllerCommand } from "../contracts/controller-command.js";
import type { ResidentController } from "./controller-registry.js";

export interface HarnessRuntimeEventSink {
  pi(event: string, data: JsonValue): Promise<unknown>;
}

export class ControllerEventRouter implements HarnessRuntimeEventSink {
  private sequence = 0;

  public constructor(
    private readonly controller: ResidentController,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private command(
    source: ControllerCommand["source"],
    kind: ControllerCommand["kind"],
    event: string,
    data: JsonValue,
  ): ControllerCommand {
    this.sequence += 1;
    const timestamp = this.now();
    return {
      schemaVersion: 1,
      source,
      kind,
      idempotencyKey: `${source}:${event}:${timestamp}:${this.sequence}`,
      payload: { event, data, timestamp },
    };
  }

  public pi(event: string, data: JsonValue): Promise<unknown> {
    return this.controller.enqueue(this.command("pi", "runtime_event", event, data));
  }

  public herdr(event: string, data: JsonValue): Promise<unknown> {
    return this.controller.enqueue(this.command("herdr", "runtime_event", event, data));
  }

  public tick(reason: string): Promise<unknown> {
    return this.controller.enqueue(this.command("timer", "tick", reason, { reason }));
  }
}

export interface PlanningEventEntryPort {
  appendEntry(type: string, data: unknown): Promise<string> | string;
  hasEntry(type: string, correlationId: string): Promise<boolean>;
}

export interface TerminalTranscriptProof {
  readonly correlationId: string;
  readonly generation: number;
  readonly finalTurnIndex: number;
  readonly terminalEntryId: string;
  readonly terminalEntryHash: string;
  readonly correlatedUserMessage: boolean;
  readonly acceptedStopReason: boolean;
  readonly completeToolResults: boolean;
  readonly noLaterUserMessage: boolean;
  readonly sessionIdle: boolean;
}

interface ActivePlanningTurn {
  readonly correlationId: string;
  readonly generation: number;
  started: boolean;
  lastCompletedTurn?: number;
}

const planningMarker = /<!-- harness-planning:([A-Za-z0-9._-]+):([1-9][0-9]*) -->/;

export class PiPlanningEventStateMachine {
  private active: ActivePlanningTurn | undefined;

  public constructor(private readonly entries: PlanningEventEntryPort) {}

  public async beforeAgentStart(prompt: string): Promise<void> {
    const marker = planningMarker.exec(prompt);
    if (!marker) return;
    if (this.active !== undefined) {
      throw new Error("a correlated planning agent run is already active");
    }
    this.active = {
      correlationId: marker[1]!,
      generation: Number(marker[2]),
      started: false,
    };
  }

  public async turnStart(turnIndex: number): Promise<void> {
    if (this.active === undefined || this.active.started) return;
    this.active.started = true;
    await this.entries.appendEntry("harness:planning-start", {
      correlationId: this.active.correlationId,
      generation: this.active.generation,
      firstTurnIndex: turnIndex,
    });
  }

  public turnEnd(turnIndex: number): void {
    if (this.active === undefined) return;
    this.active.lastCompletedTurn = turnIndex;
  }

  public async agentSettled(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    if (!active.started || active.lastCompletedTurn === undefined) {
      await this.entries.appendEntry("harness:planning-aborted", {
        correlationId: active.correlationId,
        generation: active.generation,
        reason: "agent settled without a completed correlated turn",
      });
      this.active = undefined;
      return;
    }
    await this.entries.appendEntry("harness:planning-complete", {
      correlationId: active.correlationId,
      generation: active.generation,
      finalTurnIndex: active.lastCompletedTurn,
    });
    this.active = undefined;
  }

  public async recover(proof: TerminalTranscriptProof): Promise<void> {
    if (
      !proof.correlatedUserMessage ||
      !proof.acceptedStopReason ||
      !proof.completeToolResults ||
      !proof.noLaterUserMessage ||
      !proof.sessionIdle
    ) {
      throw new Error("planning transcript has no safe terminal boundary");
    }
    if (await this.entries.hasEntry("harness:planning-recovered", proof.correlationId)) {
      return;
    }
    await this.entries.appendEntry("harness:planning-recovered", {
      correlationId: proof.correlationId,
      generation: proof.generation,
      finalTurnIndex: proof.finalTurnIndex,
      terminalEntryId: proof.terminalEntryId,
      terminalEntryHash: proof.terminalEntryHash,
    });
  }
}
