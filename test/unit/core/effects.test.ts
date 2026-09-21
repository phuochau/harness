import { expect, it } from "vitest";
import {
  effectExecutor,
  fakeHandler,
  fixtureIntent,
} from "../../support/state-fixtures.js";

it("executes a fresh non-retryable intent without reconciling", async () => {
  const handler = fakeHandler({
    recovery: () => "non_retryable",
    reconcile: { status: "indeterminate", evidence: ["not started"] },
  });
  await effectExecutor(handler).runFresh(
    fixtureIntent({ recovery: "non_retryable" }),
  );
  expect(handler.reconcile).not.toHaveBeenCalled();
  expect(handler.execute).toHaveBeenCalledOnce();
});

it("reconciles during recovery before considering execution", async () => {
  const handler = fakeHandler({
    recovery: () => "reconcilable",
    reconcile: { status: "observed", output: { agentId: "a1" } },
  });
  const result = await effectExecutor(handler).recover(fixtureIntent());
  expect(result).toEqual({ agentId: "a1" });
  expect(handler.execute).not.toHaveBeenCalled();
});

it("blocks an indeterminate non-retryable effect", async () => {
  const handler = fakeHandler({
    recovery: () => "non_retryable",
    reconcile: {
      status: "indeterminate",
      evidence: ["exit status lost"],
    },
  });
  await expect(
    effectExecutor(handler).recover(fixtureIntent({ recovery: "non_retryable" })),
  ).rejects.toMatchObject({ code: "INDETERMINATE_EFFECT" });
});

it("executes only after definitive not-found reconciliation", async () => {
  for (const recovery of ["idempotent", "reconcilable"] as const) {
    const handler = fakeHandler({
      recovery: () => recovery,
      reconcile: { status: "not_found" },
    });
    await expect(
      effectExecutor(handler).recover(fixtureIntent({ recovery })),
    ).resolves.toEqual({ ok: true });
    expect(handler.reconcile).toHaveBeenCalledOnce();
    expect(handler.execute).toHaveBeenCalledOnce();
  }
});

it("rejects recovery-class mismatches", async () => {
  const handler = fakeHandler({ recovery: () => "idempotent" });
  await expect(
    effectExecutor(handler).runFresh(fixtureIntent({ recovery: "reconcilable" })),
  ).rejects.toThrow(/recovery mismatch/);
});
