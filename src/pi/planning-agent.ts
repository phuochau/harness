import type {
  PlanningEnqueueContext,
  PlanningRequest,
  PlanningRunReceipt,
} from "../ports/planning.js";
import { deepFreeze } from "../shared/deep-freeze.js";

export interface PiSessionInspection {
  readonly idle: boolean;
  readonly persistent: boolean;
  readonly sessionFile?: string;
}

export type PlanningSettlement =
  | { readonly status: "active" }
  | {
      readonly status: "settled";
      readonly finalTurnIndex: number;
      readonly recovered: boolean;
    }
  | {
      readonly status: "ambiguous";
      readonly evidence: readonly string[];
    };

export interface PiPlanningEntry {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
}

export interface PiPlanningPort {
  inspectSession(): Promise<PiSessionInspection>;
  activePlanningReceipt(): Promise<PlanningRunReceipt | undefined>;
  nextGeneration(correlationId: string): Promise<number>;
  appendEntry(type: string, data: unknown): Promise<string>;
  sendUserMessage(
    message: string,
    options: { readonly expandPromptTemplates: true },
  ): Promise<void>;
  readEntry(id: string): Promise<PiPlanningEntry | undefined>;
  reconcilePlanningSettlement(
    receipt: PlanningRunReceipt,
  ): Promise<PlanningSettlement>;
}

export type PlanningCorrelationObservation =
  | { readonly status: "pending" }
  | {
      readonly status: "settled";
      readonly finalTurnIndex: number;
      readonly recovered: boolean;
    }
  | {
      readonly status: "blocked";
      readonly reason: string;
      readonly evidence: readonly string[];
    };

export class PlanningCorrelationError extends Error {}

export interface PlanningProfileLifecycle {
  begin(correlationId: string): Promise<unknown>;
  settle(correlationId: string, finalTurnIndex: number): Promise<string | undefined>;
  abortBeforeDispatch(correlationId: string, reason: string): Promise<void>;
}

interface PlanningRequestEntryData {
  readonly schema: "harness/planning-request/v1";
  readonly generation: number;
  readonly request: PlanningRequest;
}

function requestEntryData(
  request: PlanningRequest,
  generation: number,
): PlanningRequestEntryData {
  return deepFreeze({
    schema: "harness/planning-request/v1" as const,
    generation,
    request: structuredClone(request),
  });
}

const commandsByStage: Readonly<Record<PlanningRequest["stage"], PlanningRequest["command"]>> = {
  specify: "/speckit.specify",
  plan: "/speckit.plan",
  tasks: "/speckit.tasks",
};

function isPlanningRequest(value: unknown): value is PlanningRequestEntryData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PlanningRequestEntryData>;
  return (
    candidate.schema === "harness/planning-request/v1" &&
    Number.isSafeInteger(candidate.generation) &&
    candidate.generation! > 0 &&
    typeof candidate.request === "object" &&
    candidate.request !== null &&
    typeof candidate.request.correlationId === "string"
  );
}

export class PiPlanningCorrelation {
  public constructor(
    private readonly pi: PiPlanningPort,
    private readonly profile?: PlanningProfileLifecycle,
  ) {}

  public async enqueue(
    request: PlanningRequest,
    context: PlanningEnqueueContext = {},
  ): Promise<PlanningRunReceipt> {
    if (commandsByStage[request.stage] !== request.command) {
      throw new PlanningCorrelationError("planning stage does not match its Spec Kit command");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(request.correlationId)) {
      throw new PlanningCorrelationError("planning correlation ID is unsafe");
    }
    const session = await this.pi.inspectSession();
    if (!session.persistent || session.sessionFile === undefined) {
      throw new PlanningCorrelationError("planning requires a persistent Pi session");
    }
    if (!session.idle) {
      throw new PlanningCorrelationError("planning requires an idle Pi session");
    }
    if ((await this.pi.activePlanningReceipt()) !== undefined) {
      throw new PlanningCorrelationError("another planning action is already pending");
    }
    const generation = await this.pi.nextGeneration(request.correlationId);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new PlanningCorrelationError("invalid planning correlation generation");
    }
    await this.profile?.begin(request.correlationId);
    try {
      const requestEntryId = await this.pi.appendEntry(
        "harness:planning-request",
        requestEntryData(request, generation),
      );
      const receipt = deepFreeze({
        correlationId: request.correlationId,
        generation,
        sessionFile: session.sessionFile,
        requestEntryId,
      });
      const marker = `<!-- harness-planning:${request.correlationId}:${generation} -->`;
      const instruction = context.instruction?.trim();
      await this.pi.sendUserMessage(
        `${request.command}${instruction ? ` ${instruction}` : ""}\n\n${marker}`,
        { expandPromptTemplates: true },
      );
      return receipt;
    } catch (error) {
      await this.profile?.abortBeforeDispatch(
        request.correlationId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  public async request(receipt: PlanningRunReceipt): Promise<PlanningRequest | undefined> {
    const entry = await this.pi.readEntry(receipt.requestEntryId);
    if (
      entry?.type !== "harness:planning-request" ||
      !isPlanningRequest(entry.data) ||
      entry.data.request.correlationId !== receipt.correlationId ||
      entry.data.generation !== receipt.generation
    ) {
      return undefined;
    }
    return deepFreeze(structuredClone(entry.data.request));
  }

  public async observe(
    receipt: PlanningRunReceipt,
  ): Promise<PlanningCorrelationObservation> {
    const settlement = await this.pi.reconcilePlanningSettlement(receipt);
    if (settlement.status === "active") return { status: "pending" };
    if (settlement.status === "ambiguous") {
      return {
        status: "blocked",
        reason: "planning transcript has no safe terminal boundary",
        evidence: [...settlement.evidence],
      };
    }
    const drift = await this.profile?.settle(
      receipt.correlationId,
      settlement.finalTurnIndex,
    );
    if (drift !== undefined) {
      return {
        status: "blocked",
        reason: drift,
        evidence: [receipt.correlationId, receipt.requestEntryId],
      };
    }
    return deepFreeze({
      status: "settled" as const,
      finalTurnIndex: settlement.finalTurnIndex,
      recovered: settlement.recovered,
    });
  }
}
