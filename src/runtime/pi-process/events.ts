import { sha256 } from "../../shared/sha256.js";
import type { PiTerminalBoundary } from "./types.js";

export interface PiEventRecord {
  readonly event: Readonly<Record<string, unknown>>;
  readonly raw: string;
  readonly rawHash: `sha256:${string}`;
}

export interface PiEventParseFinish {
  readonly trailingFragment: string;
}

function eventRecord(raw: string): PiEventRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return {
      event: value as Readonly<Record<string, unknown>>,
      raw,
      rawHash: sha256(raw),
    };
  } catch {
    return undefined;
  }
}

export class PiEventStreamParser {
  private buffer = "";

  public push(chunk: string | Uint8Array): readonly PiEventRecord[] {
    this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const records: PiEventRecord[] = [];
    for (const line of lines) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (normalized.trim() === "") continue;
      const record = eventRecord(normalized);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  public finish(): PiEventParseFinish {
    return { trailingFragment: this.buffer };
  }
}

export interface ReducedPiEvents {
  readonly events: readonly PiEventRecord[];
  readonly unknownEvents: readonly PiEventRecord[];
  readonly terminal: PiTerminalBoundary;
}

const knownEventTypes = new Set([
  "message_end",
  "turn_end",
  "agent_settled",
  "tool_execution_start",
  "tool_execution_end",
  "tool_call_start",
  "tool_call_end",
  "session",
  "provider_session",
  "process_exit",
  "custom",
]);

function normalizeRecord(value: PiEventRecord | Readonly<Record<string, unknown>>): PiEventRecord {
  if ("event" in value && "rawHash" in value && "raw" in value) {
    return value as PiEventRecord;
  }
  const raw = JSON.stringify(value);
  return { event: value, raw, rawHash: sha256(raw) };
}

function field(event: Readonly<Record<string, unknown>>, name: string): unknown {
  if (name in event) return event[name];
  const payload = event.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return (payload as Readonly<Record<string, unknown>>)[name];
  }
  return undefined;
}

function messageField(event: Readonly<Record<string, unknown>>, name: string): unknown {
  const message = field(event, "message");
  if (typeof message === "object" && message !== null && !Array.isArray(message)) {
    return (message as Readonly<Record<string, unknown>>)[name];
  }
  return field(event, name);
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return "";
      const record = part as Readonly<Record<string, unknown>>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
  return text === "" ? undefined : text;
}

export function reducePiEvents(
  input: readonly (PiEventRecord | Readonly<Record<string, unknown>>)[],
): ReducedPiEvents {
  const events = input.map(normalizeRecord);
  const unknownEvents: PiEventRecord[] = [];
  const activeTools = new Set<string>();
  let settled = false;
  let acceptedStopReason = false;
  let finalAssistantText: string | undefined;
  let providerSession: PiTerminalBoundary["providerSession"];

  for (const record of events) {
    const type = record.event.type;
    if (typeof type !== "string" || !knownEventTypes.has(type)) {
      unknownEvents.push(record);
      continue;
    }
    if (type === "agent_settled") settled = true;
    if (type === "turn_end") {
      const reason = messageField(record.event, "stopReason");
      acceptedStopReason = reason === "stop" || reason === "end_turn";
    }
    if (type === "message_end" && messageField(record.event, "role") === "assistant") {
      finalAssistantText = textContent(messageField(record.event, "content"));
    }
    if (type === "tool_execution_start" || type === "tool_call_start") {
      const id = field(record.event, "toolCallId") ?? field(record.event, "id");
      if (typeof id === "string") activeTools.add(id);
    }
    if (type === "tool_execution_end" || type === "tool_call_end") {
      const id = field(record.event, "toolCallId") ?? field(record.event, "id");
      if (typeof id === "string") activeTools.delete(id);
    }
    if (type === "session" || type === "provider_session") {
      const source = field(record.event, "source");
      const id = field(record.event, "id");
      if (typeof source === "string" && typeof id === "string") {
        providerSession = { source, id };
      }
    }
  }

  const terminal: PiTerminalBoundary = {
    settled,
    acceptedStopReason,
    completeToolResults: activeTools.size === 0,
    ...(finalAssistantText === undefined ? {} : { finalAssistantText }),
    ...(providerSession === undefined ? {} : { providerSession }),
  };
  return { events, unknownEvents, terminal };
}
