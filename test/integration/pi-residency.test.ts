import { expect, it } from "vitest";
import type { ControllerCommand } from "../../src/contracts/controller-command.js";
import { HarnessController } from "../../src/controller/controller.js";
import { ControllerCommandQueue } from "../../src/controller/command-queue.js";
import {
  ControllerRegistry,
  type ActiveRun,
} from "../../src/pi/controller-registry.js";
import {
  ControllerEventRouter,
  PiPlanningEventStateMachine,
} from "../../src/pi/events.js";
import {
  PlanningProfileCoordinator,
  type ModelIdentity,
  type PiModelPort,
  type PlanningProfileLease,
  type PlanningProfileStore,
} from "../../src/pi/planning-profile.js";

it("reuses one recovered controller per canonical repository and run", async () => {
  let recoveries = 0;
  const controller = { enqueue: async () => ({ commandKey: "x", stateRevision: 1 }) };
  const registry = new ControllerRegistry({
    recover: async (_run: ActiveRun) => {
      recoveries += 1;
      return controller;
    },
  });
  const left = await registry.getOrRecover({ repositoryRoot: process.cwd(), runId: "F023" });
  const right = await registry.getOrRecover({ repositoryRoot: `${process.cwd()}/.`, runId: "F023" });
  expect(left).toBe(right);
  expect(recoveries).toBe(1);
});

it("routes Pi, process, and timer wakeups only through the serialized queue", async () => {
  let active = 0;
  let maxConcurrent = 0;
  const seen: ControllerCommand[] = [];
  const queue = new ControllerCommandQueue<ControllerCommand>({
    accept: async (command) => {
      seen.push(command);
      return { commandKey: command.idempotencyKey };
    },
    processReceived: async (commandKey) => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { commandKey, stateRevision: seen.length };
    },
    pendingCommandKeysInSequenceOrder: async () => [],
  });
  const controller = new HarnessController(queue);
  const router = new ControllerEventRouter(controller, () => "2026-09-21T00:00:00.000Z");
  await Promise.all([
    router.pi("turn_end", { turnIndex: 1 }),
    router.process("process_exit", { target: "implement:T001" }),
    router.tick("scheduler"),
  ]);
  expect(maxConcurrent).toBe(1);
  expect(seen.map((command) => command.source)).toEqual(["pi", "process", "timer"]);
});

it("records planning completion only at agent_settled, never at a bare turn_end", async () => {
  const entries: Array<{ type: string; data: any }> = [];
  const machine = new PiPlanningEventStateMachine({
    appendEntry: async (type, data) => {
      entries.push({ type, data });
      return `entry-${entries.length}`;
    },
    hasEntry: async (type, correlationId) =>
      entries.some(
        (entry) => entry.type === type && entry.data.correlationId === correlationId,
      ),
  });
  await machine.beforeAgentStart(
    "/speckit.tasks\n\n<!-- harness-planning:planning-tasks:1 -->",
  );
  await machine.turnStart(2);
  machine.turnEnd(2);
  await machine.turnStart(3);
  machine.turnEnd(3);
  expect(entries.filter((entry) => entry.type === "harness:planning-complete")).toHaveLength(0);
  await machine.agentSettled();
  expect(entries.at(-1)).toEqual({
    type: "harness:planning-complete",
    data: { correlationId: "planning-tasks", generation: 1, finalTurnIndex: 3 },
  });
});

it("recovers a terminal transcript once and rejects incomplete proof", async () => {
  const entries: Array<{ type: string; data: any }> = [];
  const machine = new PiPlanningEventStateMachine({
    appendEntry: async (type, data) => {
      entries.push({ type, data });
      return `entry-${entries.length}`;
    },
    hasEntry: async (type, correlationId) =>
      entries.some(
        (entry) => entry.type === type && entry.data.correlationId === correlationId,
      ),
  });
  const proof = {
    correlationId: "planning-plan",
    generation: 2,
    finalTurnIndex: 5,
    terminalEntryId: "assistant-5",
    terminalEntryHash: `sha256:${"a".repeat(64)}`,
    correlatedUserMessage: true,
    acceptedStopReason: true,
    completeToolResults: true,
    noLaterUserMessage: true,
    sessionIdle: true,
  };
  await machine.recover(proof);
  await machine.recover(proof);
  expect(entries.filter((entry) => entry.type === "harness:planning-recovered")).toHaveLength(1);
  await expect(
    machine.recover({ ...proof, correlationId: "unsafe", completeToolResults: false }),
  ).rejects.toThrow(/no safe terminal boundary/);
});

class FakeProfileStore implements PlanningProfileStore {
  public lease: PlanningProfileLease | undefined;
  public restored = new Set<string>();
  public drifts = new Map<string, string>();
  public async activeLease() { return this.lease; }
  public async isRestored(id: string) { return this.restored.has(id); }
  public async driftReason(correlationId: string) { return this.drifts.get(correlationId); }
}

class FakeModelPort implements PiModelPort {
  public model: ModelIdentity = { provider: "anthropic", modelId: "interactive-model" };
  public thinking = "medium";
  public readonly entries: Array<{ id: string; type: string; data: any }> = [];
  public constructor(private readonly store: FakeProfileStore) {}
  public async currentModel() { return this.model; }
  public async currentThinkingLevel() { return this.thinking; }
  public async resolveAuthenticatedProfile(name: string) {
    return name === "chatgpt-planning"
      ? { model: { provider: "openai-codex", modelId: "chatgpt-planning-model" }, thinkingLevel: "high" }
      : undefined;
  }
  public async resolveModelIdentity(identity: ModelIdentity) { return identity; }
  public async selectModel(model: ModelIdentity) { this.model = model; }
  public async selectThinkingLevel(level: string) { this.thinking = level; }
  public appendEntry(type: string, data: any) {
    const id = `entry-${this.entries.length + 1}`;
    this.entries.push({ id, type, data });
    if (type === "harness:planning-profile-selected") {
      this.store.lease = { ...data, entryId: id };
    }
    if (type === "harness:planning-profile-restored") {
      this.store.restored.add(data.selectedEntryId);
      this.store.lease = undefined;
    }
    if (type === "harness:planning-profile-drift") {
      this.store.drifts.set(data.correlationId, data.reason);
    }
  }
  public getLeafId() { return this.entries.at(-1)?.id; }
}

it("holds the ChatGPT planning profile until exact agent settlement", async () => {
  const store = new FakeProfileStore();
  const pi = new FakeModelPort(store);
  const profile = new PlanningProfileCoordinator(pi, store);
  const lease = await profile.begin("planning-tasks");
  expect(pi.model.modelId).toBe("chatgpt-planning-model");
  expect(pi.thinking).toBe("high");
  expect(store.restored.size).toBe(0);
  await profile.restoreAfterSettlement(lease, {
    correlationId: "planning-tasks",
    terminal: true,
    finalTurnIndex: 3,
  });
  expect(pi.model.modelId).toBe("interactive-model");
  expect(pi.thinking).toBe("medium");
  expect(store.restored.has(lease.entryId)).toBe(true);
});

it("durably blocks a planning generation when its selected model drifts", async () => {
  const store = new FakeProfileStore();
  const pi = new FakeModelPort(store);
  const profile = new PlanningProfileCoordinator(pi, store);
  const lease = await profile.begin("planning-plan");
  await profile.observeIdentity(
    { provider: "anthropic", modelId: "unexpected-model" },
    "high",
  );
  expect(await store.driftReason("planning-plan")).toMatch(/model drift/);
  await profile.restoreAfterSettlement(lease, {
    correlationId: "planning-plan",
    terminal: true,
    finalTurnIndex: 4,
  });
  expect(pi.entries.filter((entry) => entry.type === "harness:planning-profile-drift")).toHaveLength(1);
});

it("detects model drift at settlement even when no model-select event was routed", async () => {
  const store = new FakeProfileStore();
  const pi = new FakeModelPort(store);
  const profile = new PlanningProfileCoordinator(pi, store);
  await profile.begin("planning-specify");
  pi.model = { provider: "anthropic", modelId: "changed-out-of-band" };
  const drift = await profile.settle("planning-specify", 2);
  expect(drift).toMatch(/model drift/);
  expect(pi.model.modelId).toBe("interactive-model");
  expect(pi.thinking).toBe("medium");
});
