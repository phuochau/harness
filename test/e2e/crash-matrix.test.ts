import { afterEach, expect, it } from "vitest";
import {
  controllerQueueFixture,
  command,
} from "../support/controller-fixtures.js";
import {
  CrashSafeEffectHarness,
  crashBoundaries,
} from "../support/fault-injector.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it.each([
  ["after-command-received", { crashAfterEvent: "controller.command_received" }],
  ["after-command-decided", { crashAfterEvent: "controller.command_decided" }],
  ["after-first-decision-member", { crashAfterBatchMember: 1 }],
] as const)("recovers %s from the real durable command processor", async (_name, options) => {
  const fixture = await controllerQueueFixture(options);
  cleanups.push(() => fixture.cleanup());
  const input = command("operator", "operator:retry:T001");
  await expect(fixture.queue.enqueue(input)).rejects.toThrow(/injected crash/);
  await fixture.restartAndRecoverPending();
  expect(fixture.eventsFor("controller.command_received", input.idempotencyKey)).toHaveLength(1);
  expect(fixture.eventsFor("controller.command_processed", input.idempotencyKey)).toHaveLength(1);
  expect(fixture.operatorIntents("retry", "T001")).toHaveLength(1);
});

it.each(crashBoundaries)("recovers %s without duplicate external effects", (boundary) => {
  const harness = new CrashSafeEffectHarness(boundary);
  harness.crashAndRestart();
  expect(harness.duplicateEffectKeys()).toEqual([]);
  expect(harness.eventChainValid()).toBe(true);
});
