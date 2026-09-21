import { expect, it } from "vitest";
import {
  ApprovalAction,
  ApprovalPendingError,
} from "../../../src/actions/approval.js";
import type {
  ActionContext,
  ApprovalStore,
  EffectIntent,
} from "../../../src/actions/types.js";
import { actionContext } from "../../support/state-fixtures.js";

function intent(requestId: string): EffectIntent<"human.approval", { requestId: string }> {
  return {
    action: "human.approval",
    idempotencyKey: requestId,
    recovery: "reconcilable",
    laneKey: "approval:F023",
    input: { requestId },
  };
}

function contextWith(approvals: ApprovalStore): ActionContext {
  return { ...actionContext(), approvals };
}

it("reconciles an approval by request id", async () => {
  const approvals: ApprovalStore = {
    get: async (requestId) =>
      requestId === "approve:F023"
        ? {
            approved: true,
            actor: "operator@example.invalid",
            recordedAt: "2026-09-21T00:00:00.000Z",
          }
        : undefined,
  };
  const handler = new ApprovalAction();
  await expect(
    handler.reconcile(contextWith(approvals), intent("approve:F023")),
  ).resolves.toEqual({ status: "observed", output: { approved: true } });
});

it("stays pending without opening an implicit prompt", async () => {
  const handler = new ApprovalAction();
  const context = contextWith({ get: async () => undefined });
  await expect(
    handler.reconcile(context, intent("approve:F024")),
  ).resolves.toEqual({ status: "not_found" });
  await expect(handler.execute(context, intent("approve:F024"))).rejects.toBeInstanceOf(
    ApprovalPendingError,
  );
});

it("observes an explicit rejection as a completed approval decision", async () => {
  const handler = new ApprovalAction();
  const context = contextWith({
    get: async () => ({
      approved: false,
      actor: "operator@example.invalid",
      recordedAt: "2026-09-21T00:00:00.000Z",
    }),
  });
  await expect(handler.execute(context, intent("approve:F025"))).resolves.toEqual({
    approved: false,
  });
});
