import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PlanningRequest,
  PlanningRunReceipt,
} from "../../../src/ports/planning.js";
import {
  PiPlanningCorrelation,
  type PiPlanningPort,
  type PlanningSettlement,
} from "../../../src/pi/planning-agent.js";
import { PlanningAction } from "../../../src/speckit/planning-action.js";
import { sha256 } from "../../../src/shared/sha256.js";
import { sealTaskGraph } from "../../../src/speckit/seal-task-graph.js";
import {
  artifactPaths,
  exactTaskDocumentFixture,
  planningProjectFixture,
  quickTaskDocumentFixture,
} from "../../support/planning-fixtures.js";

class FakePiPlanningPort implements PiPlanningPort {
  public readonly sentMessages: string[] = [];
  private readonly sessionEntries: Array<{
    id: string;
    type: string;
    data: unknown;
  }> = [];
  private readonly settlements = new Map<string, PlanningSettlement>();
  private activeReceipt: PlanningRunReceipt | undefined;

  public async inspectSession() {
    return { idle: true, persistent: true, sessionFile: "/tmp/pi-session.jsonl" };
  }

  public async activePlanningReceipt() {
    return this.activeReceipt;
  }

  public async nextGeneration(correlationId: string) {
    return this.sessionEntries.filter(
      (entry) =>
        entry.type === "harness:planning-request" &&
        (entry.data as { request?: { correlationId?: string } }).request?.correlationId ===
          correlationId,
    ).length + 1;
  }

  public async appendEntry(type: string, data: unknown) {
    const id = `entry-${this.sessionEntries.length + 1}`;
    this.sessionEntries.push({ id, type, data });
    return id;
  }

  public async sendUserMessage(message: string) {
    this.sentMessages.push(message);
    const marker = /harness-planning:([^:]+):(\d+)/.exec(message);
    const requestEntry = [...this.sessionEntries]
      .reverse()
      .find((entry) => entry.type === "harness:planning-request");
    if (!marker || !requestEntry) throw new Error("missing planning marker");
    this.activeReceipt = {
      correlationId: marker[1]!,
      generation: Number(marker[2]),
      requestEntryId: requestEntry.id,
      sessionFile: "/tmp/pi-session.jsonl",
    };
  }

  public async readEntry(id: string) {
    return this.sessionEntries.find((entry) => entry.id === id);
  }

  public async reconcilePlanningSettlement(receipt: PlanningRunReceipt) {
    const settlement = this.settlements.get(receipt.correlationId);
    if (settlement?.status === "settled" && settlement.recovered) {
      const alreadyRecovered = this.sessionEntries.some(
        (entry) =>
          entry.type === "harness:planning-recovered" &&
          (entry.data as { correlationId?: string }).correlationId ===
            receipt.correlationId,
      );
      if (!alreadyRecovered) {
        await this.appendEntry("harness:planning-recovered", {
          correlationId: receipt.correlationId,
          finalTurnIndex: settlement.finalTurnIndex,
        });
      }
    }
    return settlement ?? ({ status: "active" } as const);
  }

  public emitUnrelatedTurn(): void {
    this.sessionEntries.push({
      id: `entry-${this.sessionEntries.length + 1}`,
      type: "assistant",
      data: { turnIndex: 7, correlated: false, stopReason: "stop" },
    });
  }

  public complete(receipt: PlanningRunReceipt): void {
    this.settlements.set(receipt.correlationId, {
      status: "settled",
      finalTurnIndex: 8,
      recovered: false,
    });
    this.activeReceipt = undefined;
  }

  public writeTerminalTranscript(receipt: PlanningRunReceipt): void {
    this.sessionEntries.push({
      id: `entry-${this.sessionEntries.length + 1}`,
      type: "assistant",
      data: {
        correlationId: receipt.correlationId,
        turnIndex: 9,
        stopReason: "stop",
        toolResultsComplete: true,
      },
    });
    this.settlements.set(receipt.correlationId, {
      status: "settled",
      finalTurnIndex: 9,
      recovered: true,
    });
    this.activeReceipt = undefined;
  }

  public markAmbiguous(receipt: PlanningRunReceipt): void {
    this.settlements.set(receipt.correlationId, {
      status: "ambiguous",
      evidence: ["later user entry exists"],
    });
    this.activeReceipt = undefined;
  }

  public entries(type: string) {
    return this.sessionEntries.filter((entry) => entry.type === type);
  }
}

describe("correlated Pi planning", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function fixture(stage: PlanningRequest["stage"] = "specify") {
    const project = await planningProjectFixture();
    cleanups.push(project.cleanup);
    const pi = new FakePiPlanningPort();
    const sealCalls: Readonly<Record<string, string>>[] = [];
    const sealer = {
      sealPlanningArtifacts: async (hashes: Readonly<Record<string, string>>) => {
        sealCalls.push(hashes);
        return { commit: "a".repeat(40), hashes };
      },
    };
    const action = () =>
      new PlanningAction({
        root: project.root,
        correlation: new PiPlanningCorrelation(pi),
        sealer,
      });
    const required =
      stage === "specify"
        ? [artifactPaths.spec]
        : stage === "plan"
          ? [artifactPaths.spec, artifactPaths.plan]
          : [artifactPaths.spec, artifactPaths.plan, artifactPaths.tasks];
    const hashes: Record<string, string> = {};
    for (const path of required) {
      hashes[path] = sha256(await readFile(join(project.root, path)));
    }
    const request: PlanningRequest = {
      stage,
      command:
        stage === "specify"
          ? "/speckit.specify"
          : stage === "plan"
            ? "/speckit.plan"
            : stage === "tasks"
              ? "/speckit.tasks"
              : "/harness.quick-plan",
      correlationId: `planning-${stage}`,
      artifactPaths,
      baseline: { hashes },
      ...(stage === "quick"
        ? { kind: "bugfix" as const, brief: "Fix the parser crash on empty input" }
        : {}),
    };
    const changeArtifacts = async (
      tasksText = quickTaskDocumentFixture(),
    ) => {
      if (stage === "specify") {
        await writeFile(
          join(project.root, artifactPaths.spec),
          "# Specification\n\n- FR-001: Changed parser behavior\n- SC-001: Parser verification\n",
          "utf8",
        );
      } else if (stage === "plan") {
        await writeFile(
          join(project.root, artifactPaths.plan),
          "# Plan\n\nUse a changed deterministic parser.\n",
          "utf8",
        );
      } else if (stage === "quick") {
        await writeFile(
          join(project.root, artifactPaths.spec),
          "# Specification\n\n- FR-001: Parser crash fixed\n- SC-001: Crash regression verified\n",
          "utf8",
        );
        await writeFile(
          join(project.root, artifactPaths.plan),
          "# Plan\n\nAdd a failing regression test, then fix the parser.\n",
          "utf8",
        );
        await writeFile(join(project.root, artifactPaths.tasks), tasksText, "utf8");
      } else {
        await writeFile(
          join(project.root, artifactPaths.tasks),
          exactTaskDocumentFixture({ checkbox: "x" }),
          "utf8",
        );
      }
    };
    return { root: project.root, pi, action, request, changeArtifacts, sealCalls };
  }

  it("does not accept old artifacts after an unrelated turn ends", async () => {
    const run = await fixture();
    const receipt = await run.action().execute(run.request);
    run.pi.emitUnrelatedTurn();
    await expect(run.action().observe(receipt)).resolves.toEqual({ status: "pending" });
  });

  it("accepts only new hashes from the correlated turn", async () => {
    const run = await fixture();
    const action = run.action();
    const receipt = await action.execute(run.request);
    await run.changeArtifacts();
    run.pi.complete(receipt);
    await expect(action.observe(receipt)).resolves.toMatchObject({
      status: "completed",
      correlationId: receipt.correlationId,
    });
  });

  it("blocks a correlated turn that leaves the required artifact unchanged", async () => {
    const run = await fixture();
    const action = run.action();
    const receipt = await action.execute(run.request);
    run.pi.complete(receipt);
    await expect(action.observe(receipt)).resolves.toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/did not change/),
    });
  });

  it("recovers a settled planning turn after Pi crashed before the completion entry", async () => {
    const run = await fixture();
    const receipt = await run.action().execute(run.request);
    await run.changeArtifacts();
    run.pi.writeTerminalTranscript(receipt);
    const restarted = run.action();
    await expect(restarted.observe(receipt)).resolves.toMatchObject({
      status: "completed",
    });
    expect(run.pi.entries("harness:planning-recovered")).toHaveLength(1);
    await restarted.observe(receipt);
    expect(run.pi.entries("harness:planning-recovered")).toHaveLength(1);
  });

  it("keeps an interrupted generation pending without terminal native evidence", async () => {
    const run = await fixture();
    const receipt = await run.action().execute(run.request);
    await expect(run.action().observe(receipt)).resolves.toEqual({ status: "pending" });
    expect(run.pi.entries("harness:planning-recovered")).toHaveLength(0);
  });

  it("blocks an ambiguous terminal transcript", async () => {
    const run = await fixture();
    const receipt = await run.action().execute(run.request);
    run.pi.markAmbiguous(receipt);
    await expect(run.action().observe(receipt)).resolves.toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/no safe terminal boundary/),
      evidence: ["later user entry exists"],
    });
  });

  it("seals the complete quick artifact set from a single correlated turn", async () => {
    const run = await fixture("quick");
    const action = run.action();
    const receipt = await action.execute(run.request);
    await run.changeArtifacts();
    run.pi.complete(receipt);
    const observation = await action.observe(receipt);
    expect(observation).toMatchObject({
      status: "completed",
      artifacts: {
        commit: expect.any(String),
        graph: expect.objectContaining({ schema: "harness/task-graph/v1" }),
      },
    });
    expect(run.sealCalls).toHaveLength(1);
    expect(run.pi.sentMessages[0]).toContain("harness-planning:planning-quick");
    expect(run.pi.sentMessages[0]).toContain("Fix the parser crash on empty input");
  });

  it("blocks a quick turn that leaves a required artifact unchanged", async () => {
    const run = await fixture("quick");
    const action = run.action();
    const receipt = await action.execute(run.request);
    await writeFile(
      join(run.root, artifactPaths.spec),
      "# Specification\n\n- FR-001: Parser crash fixed\n- SC-001: Crash regression verified\n",
      "utf8",
    );
    run.pi.complete(receipt);
    await expect(action.observe(receipt)).resolves.toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/did not change/),
    });
  });

  it("blocks a quick turn that produces more than one canonical task", async () => {
    const run = await fixture("quick");
    const action = run.action();
    const receipt = await action.execute(run.request);
    await run.changeArtifacts(quickTaskDocumentFixture({ extraTask: true }));
    run.pi.complete(receipt);
    await expect(action.observe(receipt)).resolves.toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/exactly one task/),
    });
  });

  it("blocks a quick task missing the requested kind label", async () => {
    const run = await fixture("quick");
    const action = run.action();
    const receipt = await action.execute(run.request);
    await run.changeArtifacts(quickTaskDocumentFixture({ kind: "small-feature" }));
    run.pi.complete(receipt);
    await expect(action.observe(receipt)).resolves.toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/bugfix/),
    });
  });

  it.each([
    { options: { parallel: true }, reason: /non-parallel|parallel/i },
    { options: { acceptanceRefs: [] }, reason: /acceptance reference/ },
    { options: { ownedPaths: [] }, reason: /owned path/i },
  ])("blocks a quick task violating the contract %o", async ({ options, reason }) => {
    const run = await fixture("quick");
    const action = run.action();
    const receipt = await action.execute(run.request);
    await run.changeArtifacts(quickTaskDocumentFixture(options));
    run.pi.complete(receipt);
    await expect(action.observe(receipt)).resolves.toMatchObject({
      status: "blocked",
      reason,
    });
  });

  it("seals the final tasks artifact set on the run branch", async () => {
    const run = await fixture("tasks");
    const action = run.action();
    const receipt = await action.execute(run.request);
    await run.changeArtifacts();
    run.pi.complete(receipt);
    const observation = await action.observe(receipt);
    expect(observation).toMatchObject({
      status: "completed",
      artifacts: { commit: expect.any(String) },
    });
    expect(run.sealCalls).toHaveLength(1);
  });

  it("allows only one pending planning action per persistent Pi session", async () => {
    const run = await fixture();
    await run.action().execute(run.request);
    await expect(
      run.action().execute({ ...run.request, correlationId: "another" }),
    ).rejects.toThrow(/already pending/);
  });

  it("binds existing approved artifacts without starting a Pi turn", async () => {
    const run = await fixture("tasks");
    await sealTaskGraph({
      root: run.root,
      paths: artifactPaths,
      tasksText: await readFile(join(run.root, artifactPaths.tasks), "utf8"),
      specText: await readFile(join(run.root, artifactPaths.spec), "utf8"),
    });
    const calls: Array<{ paths: readonly string[]; hashes: Readonly<Record<string, string>> }> = [];
    const observation = await run.action().acceptExistingApproved(run.request, {
      bindExistingApproved: async (paths, hashes) => {
        calls.push({ paths, hashes });
        return { commit: "b".repeat(40) };
      },
    });
    expect(observation).toMatchObject({
      status: "completed",
      artifacts: { commit: "b".repeat(40) },
    });
    expect(calls[0]?.paths).toEqual([
      artifactPaths.graph,
      artifactPaths.plan,
      artifactPaths.spec,
      artifactPaths.tasks,
    ].sort());
    expect(run.pi.sentMessages).toHaveLength(0);
  });
});
