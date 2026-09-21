import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PlanningRunReceipt } from "../ports/planning.js";
import type {
  PiPlanningEntry,
  PiPlanningPort,
  PiSessionInspection,
  PlanningSettlement,
} from "./planning-agent.js";

interface CustomEntry {
  readonly id: string;
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
}

function customEntries(context: ExtensionContext): readonly CustomEntry[] {
  return context.sessionManager.getBranch().flatMap((entry) =>
    entry.type === "custom"
      ? [{ id: entry.id, type: "custom" as const, customType: entry.customType, data: entry.data }]
      : []
  );
}

function record(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function matchingEntry(
  entries: readonly CustomEntry[],
  type: string,
  receipt: PlanningRunReceipt,
): CustomEntry | undefined {
  return [...entries].reverse().find((entry) => {
    if (entry.customType !== type) return false;
    const data = record(entry.data);
    return data?.correlationId === receipt.correlationId &&
      data.generation === receipt.generation;
  });
}

export class PiSessionPlanningPort implements PiPlanningPort {
  public constructor(
    private readonly pi: ExtensionAPI,
    private readonly context: ExtensionContext,
  ) {}

  public async inspectSession(): Promise<PiSessionInspection> {
    const sessionFile = this.context.sessionManager.getSessionFile();
    return {
      idle: this.context.isIdle(),
      persistent: sessionFile !== undefined,
      ...(sessionFile === undefined ? {} : { sessionFile }),
    };
  }

  public async activePlanningReceipt(): Promise<PlanningRunReceipt | undefined> {
    const sessionFile = this.context.sessionManager.getSessionFile();
    if (sessionFile === undefined) return undefined;
    const entries = customEntries(this.context);
    for (const entry of [...entries].reverse()) {
      if (entry.customType !== "harness:planning-request") continue;
      const envelope = record(entry.data);
      const request = record(envelope?.request);
      if (
        envelope?.schema !== "harness/planning-request/v1" ||
        !Number.isSafeInteger(envelope.generation) ||
        typeof request?.correlationId !== "string"
      ) continue;
      const candidate: PlanningRunReceipt = {
        correlationId: request.correlationId,
        generation: envelope.generation,
        sessionFile,
        requestEntryId: entry.id,
      };
      if (
        matchingEntry(entries, "harness:planning-complete", candidate) === undefined &&
        matchingEntry(entries, "harness:planning-recovered", candidate) === undefined &&
        matchingEntry(entries, "harness:planning-aborted", candidate) === undefined
      ) return candidate;
    }
    return undefined;
  }

  public async nextGeneration(correlationId: string): Promise<number> {
    const generations = customEntries(this.context).flatMap((entry) => {
      if (entry.customType !== "harness:planning-request") return [];
      const envelope = record(entry.data);
      const request = record(envelope?.request);
      return request?.correlationId === correlationId && Number.isSafeInteger(envelope?.generation)
        ? [Number(envelope!.generation)]
        : [];
    });
    return Math.max(0, ...generations) + 1;
  }

  public async appendEntry(type: string, data: unknown): Promise<string> {
    this.pi.appendEntry(type, data);
    const id = this.context.sessionManager.getLeafId();
    if (id === undefined || id === null) throw new Error(`Pi did not persist ${type}`);
    return id;
  }

  public async sendUserMessage(
    message: string,
    options: { readonly expandPromptTemplates: true },
  ): Promise<void> {
    this.pi.sendUserMessage(message, options);
  }

  public async readEntry(id: string): Promise<PiPlanningEntry | undefined> {
    const entry = this.context.sessionManager.getBranch().find((candidate) => candidate.id === id);
    if (entry?.type !== "custom") return undefined;
    return { id: entry.id, type: entry.customType, data: entry.data };
  }

  public async reconcilePlanningSettlement(
    receipt: PlanningRunReceipt,
  ): Promise<PlanningSettlement> {
    if (this.context.sessionManager.getSessionFile() !== receipt.sessionFile) {
      return { status: "ambiguous", evidence: ["planning session file changed"] };
    }
    const entries = customEntries(this.context);
    const completed = matchingEntry(entries, "harness:planning-complete", receipt) ??
      matchingEntry(entries, "harness:planning-recovered", receipt);
    if (completed !== undefined) {
      const data = record(completed.data);
      if (!Number.isSafeInteger(data?.finalTurnIndex)) {
        return { status: "ambiguous", evidence: ["terminal planning marker is invalid"] };
      }
      return {
        status: "settled",
        finalTurnIndex: Number(data!.finalTurnIndex),
        recovered: completed.customType === "harness:planning-recovered",
      };
    }
    const aborted = matchingEntry(entries, "harness:planning-aborted", receipt);
    if (aborted !== undefined) {
      return {
        status: "ambiguous",
        evidence: [String(record(aborted.data)?.reason ?? "planning aborted")],
      };
    }
    return { status: "active" };
  }
}
