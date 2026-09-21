import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ActionHandler, EffectIntent } from "../../../src/actions/types.js";
import { DurableBoundAction } from "../../../src/runtime/production/bound-action.js";
import { DurableRecordStore } from "../../../src/runtime/production/records.js";
import { actionContext } from "../../support/state-fixtures.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("derives command recovery from the DSL probe and preserves success across cleanup failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-bound-action-"));
  temporary.push(root);
  const records = new DurableRecordStore(root);
  let cleanupFails = true;
  let cleanupCalls = 0;
  const handler: ActionHandler<"command.run", { argv: string[] }, { ok: boolean }> = {
    kind: "command.run",
    recovery: () => "reconcilable",
    execute: async () => ({ ok: true }),
    reconcile: async () => ({ status: "not_found" }),
  };
  const action = new DurableBoundAction({
    records,
    handler,
    binder: {
      bind: async () => ({ argv: ["true"] }),
      afterCompleted: async () => {
        cleanupCalls += 1;
        if (cleanupFails) throw new Error("verification worktree cleanup failed");
      },
    },
    recovery: (input) => Array.isArray(input.probe) ? "reconcilable" : "non_retryable",
    validateInput: (value) => value as { argv: string[] },
    validateOutput: (value) => value as { ok: boolean },
  });
  const intent: EffectIntent<"command.run", Readonly<Record<string, unknown>>> = {
    action: "command.run",
    idempotencyKey: "command.run:verify:T001:1",
    recovery: "reconcilable",
    laneKey: "job:verify:T001",
    input: { probe: ["test", "-f", "marker"] },
  };

  expect(action.recovery(intent.input)).toBe("reconcilable");
  await expect(action.execute(actionContext(), intent)).resolves.toEqual({ ok: true });
  await expect(records.get("action-cleanup-failure", intent.idempotencyKey)).resolves.toMatchObject({
    schemaVersion: 1,
    message: "verification worktree cleanup failed",
  });
  cleanupFails = false;
  await expect(action.reconcile(actionContext(), intent)).resolves.toEqual({
    status: "observed",
    output: { ok: true },
  });
  await expect(records.get("action-cleanup-failure", intent.idempotencyKey)).resolves.toBeUndefined();
  expect(cleanupCalls).toBe(2);
});
