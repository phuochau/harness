import { expect, it, vi } from "vitest";
import { PiSessionPlanningPort } from "../../src/pi/planning-port.js";

it("reconciles only the correlation- and generation-bound terminal Pi marker", async () => {
  const entries: any[] = [];
  const sessionManager = {
    getSessionFile: () => "/tmp/pi-session.jsonl",
    getLeafId: () => entries.at(-1)?.id ?? null,
    getBranch: () => entries,
  };
  const pi = {
    appendEntry(type: string, data: unknown) {
      entries.push({
        id: `entry-${entries.length + 1}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        type: "custom",
        customType: type,
        data,
      });
    },
    sendUserMessage: vi.fn(),
  };
  const context = { sessionManager, isIdle: () => true };
  const port = new PiSessionPlanningPort(pi as any, context as any);
  const request = {
    schema: "harness/planning-request/v1",
    generation: 1,
    request: { correlationId: "F001-tasks-1" },
  };
  const requestId = await port.appendEntry("harness:planning-request", request);
  const receipt = {
    correlationId: "F001-tasks-1",
    generation: 1,
    sessionFile: "/tmp/pi-session.jsonl",
    requestEntryId: requestId,
  };
  await expect(port.activePlanningReceipt()).resolves.toEqual(receipt);
  await port.appendEntry("harness:planning-complete", {
    correlationId: receipt.correlationId,
    generation: 2,
    finalTurnIndex: 7,
  });
  await expect(port.reconcilePlanningSettlement(receipt)).resolves.toEqual({ status: "active" });
  await port.appendEntry("harness:planning-complete", {
    correlationId: receipt.correlationId,
    generation: 1,
    finalTurnIndex: 8,
  });
  await expect(port.reconcilePlanningSettlement(receipt)).resolves.toEqual({
    status: "settled",
    finalTurnIndex: 8,
    recovered: false,
  });
  await expect(port.activePlanningReceipt()).resolves.toBeUndefined();
});
