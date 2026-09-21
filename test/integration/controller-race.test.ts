import { expect, it } from "vitest";
import {
  command,
  controllerQueueFixture,
  runConcurrentWakeupRace,
} from "../support/controller-fixtures.js";

it("serializes concurrent wakeups into one logical launch", async () => {
  const fixture = await controllerQueueFixture();
  try {
    const results = await Promise.all([
      fixture.queue.enqueue(command("timer", "tick:1")),
      fixture.queue.enqueue(command("process", "process-exit:a1")),
      fixture.queue.enqueue(command("operator", "retry:T001")),
    ]);
    expect(fixture.maxConcurrentTransactions).toBe(1);
    expect(
      fixture.events.filter(
        (event) =>
          event.eventType === "effect.intent" &&
          event.entityId === "implement:T001",
      ),
    ).toHaveLength(1);
    expect(results).toHaveLength(3);
  } finally {
    await fixture.cleanup();
  }
});

it("holds one integration pipeline through candidate verification and promotion", async () => {
  const fixture = await controllerQueueFixture({
    readyIntegrations: ["T001", "T002"],
  });
  try {
    await fixture.queue.enqueue(command("timer", "tick:integration"));
    expect(fixture.integrationIntents()).toHaveLength(1);
    await fixture.observeCandidateWithoutFinalizing();
    await fixture.queue.enqueue(command("timer", "tick:integration:again"));
    expect(fixture.integrationIntents()).toHaveLength(1);
    expect(fixture.state.integrationPipeline).toMatchObject({
      taskId: "T001",
      status: "verifying_candidate",
    });
  } finally {
    await fixture.cleanup();
  }
});

it("deduplicates a controller command after restart", async () => {
  const fixture = await controllerQueueFixture();
  try {
    const retry = command("operator", "retry:T001:1");
    await fixture.queue.enqueue(retry);
    await fixture.restart();
    await fixture.queue.enqueue(retry);
    expect(
      fixture.events.filter(
        (event) =>
          event.eventType === "controller.command_processed" &&
          event.payload.commandKey === retry.idempotencyKey,
      ),
    ).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

it("replays a durably received command without caller resubmission", async () => {
  const fixture = await controllerQueueFixture({
    crashAfterEvent: "controller.command_received",
  });
  try {
    const retry = command("operator", "retry:T001:accepted");
    await expect(fixture.queue.enqueue(retry)).rejects.toThrow(/injected crash/);
    expect(
      fixture.eventsFor("controller.command_received", retry.idempotencyKey),
    ).toHaveLength(1);
    await fixture.restartAndRecoverPending();
    expect(fixture.operatorIntents("retry", "T001")).toHaveLength(1);
    expect(
      fixture.eventsFor("controller.command_processed", retry.idempotencyKey),
    ).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

it("derives an undecided received command from recorded time", async () => {
  const control = await controllerQueueFixture();
  const crashed = await controllerQueueFixture({
    crashAfterEvent: "controller.command_received",
  });
  try {
    const retry = command("timer", "retry-window:T001");
    await control.queue.enqueue(retry);
    await expect(crashed.queue.enqueue(retry)).rejects.toThrow(/injected crash/);
    crashed.clock.advanceBy(86_400_000);
    await crashed.restartAndRecoverPending();
    expect(crashed.decisionBatch(retry.idempotencyKey).decisionHash).toBe(
      control.decisionBatch(retry.idempotencyKey).decisionHash,
    );
  } finally {
    await control.cleanup();
    await crashed.cleanup();
  }
});

it("replays the sealed batch instead of deriving on partial state", async () => {
  const fixture = await controllerQueueFixture({ crashAfterBatchMember: 1 });
  try {
    const input = fixture.multiDecisionOperatorCommand(
      "retry-and-reroute:T001",
    );
    await expect(fixture.queue.enqueue(input)).rejects.toThrow(/injected crash/);
    expect(fixture.derivationsFor(input.idempotencyKey)).toBe(1);
    const sealedHash = fixture.decisionBatch(input.idempotencyKey).decisionHash;
    await fixture.restartAndRecoverPending();
    expect(fixture.derivationsFor(input.idempotencyKey)).toBe(1);
    expect(fixture.decisionBatch(input.idempotencyKey).decisionHash).toBe(
      sealedHash,
    );
    expect(fixture.appliedDecisionKeys(input.idempotencyKey)).toEqual(
      fixture.sealedDecisionKeys(input.idempotencyKey),
    );
  } finally {
    await fixture.cleanup();
  }
});

it("repeats the wakeup race 100 times", async () => {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const result = await runConcurrentWakeupRace();
    expect(result.maxConcurrentTransactions).toBe(1);
    expect(result.launchIntentCount).toBe(1);
  }
});
