import { expect, it } from "vitest";
import type { EffectIntent } from "../../../src/actions/types.js";
import {
  RunApprovalAction,
  RunApprovalPendingError,
} from "../../../src/runtime/production/run-approval.js";
import { actionContext } from "../../support/state-fixtures.js";

const intent: EffectIntent<"human.approval", Readonly<Record<string, unknown>>> = {
  action: "human.approval",
  idempotencyKey: "human.approval:approve_plan:1",
  recovery: "reconcilable",
  laneKey: "job:approve_plan",
  input: { jobId: "approve_plan", stageId: "approve_plan", worker: "system" },
};

it("requires a persisted operator decision instead of auto-approving", async () => {
  const action = new RunApprovalAction();
  const pending = { ...actionContext(), approvals: { get: async () => undefined } };
  await expect(action.execute(pending, intent)).rejects.toBeInstanceOf(
    RunApprovalPendingError,
  );
  await expect(action.reconcile(pending, intent)).resolves.toEqual({
    status: "not_found",
  });

  const decided = {
    ...actionContext(),
    approvals: {
      get: async () => ({
        approved: false,
        actor: "pi-operator",
        recordedAt: "2026-09-21T00:00:00.000Z",
      }),
    },
  };
  await expect(action.execute(decided, intent)).resolves.toEqual({ approved: false });
});
