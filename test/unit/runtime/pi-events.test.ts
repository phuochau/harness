import { describe, expect, it } from "vitest";
import {
  PiEventStreamParser,
  reducePiEvents,
} from "../../../src/runtime/pi-process/events.js";
import { piEvent } from "../../support/pi-process-fixtures.js";

describe("Pi JSON events", () => {
  it("accepts one terminal assistant result only after agent_settled", () => {
    const beforeSettlement = reducePiEvents([
      piEvent("message_end", { role: "assistant", content: "RESULT" }),
      piEvent("turn_end", { stopReason: "stop" }),
    ]);
    expect(beforeSettlement.terminal.settled).toBe(false);

    const state = reducePiEvents([
      piEvent("message_end", { role: "assistant", content: "RESULT" }),
      piEvent("turn_end", { stopReason: "stop" }),
      piEvent("agent_settled"),
    ]);
    expect(state.terminal).toMatchObject({
      settled: true,
      acceptedStopReason: true,
      completeToolResults: true,
      finalAssistantText: "RESULT",
    });
  });

  it("does not accept incomplete tools or unknown events as terminal", () => {
    const state = reducePiEvents([
      piEvent("tool_execution_start", { toolCallId: "tool-1" }),
      piEvent("future_event", { settled: true }),
      piEvent("turn_end", { stopReason: "stop" }),
      piEvent("agent_settled"),
    ]);
    expect(state.terminal.completeToolResults).toBe(false);
    expect(state.unknownEvents).toHaveLength(1);
    expect(state.events.every((event) => event.rawHash.startsWith("sha256:"))).toBe(true);
  });

  it("buffers a torn final JSON line until it is completed", () => {
    const parser = new PiEventStreamParser();
    expect(parser.push('{"type":"turn_end"')).toEqual([]);
    expect(parser.finish()).toMatchObject({ trailingFragment: expect.any(String) });

    const complete = new PiEventStreamParser();
    expect(complete.push('{"type":"turn_end"')).toEqual([]);
    expect(complete.push(',"stopReason":"stop"}\n')).toHaveLength(1);
    expect(complete.finish().trailingFragment).toBe("");
  });

  it("reads authoritative assistant data from Pi's nested message shape", () => {
    const state = reducePiEvents([
      piEvent("message_end", {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "NESTED RESULT" }],
          stopReason: "stop",
        },
      }),
      piEvent("turn_end", {
        message: { role: "assistant", content: [], stopReason: "stop" },
        toolResults: [],
      }),
      piEvent("agent_settled"),
    ]);
    expect(state.terminal).toMatchObject({
      settled: true,
      acceptedStopReason: true,
      finalAssistantText: "NESTED RESULT",
    });
  });
});
