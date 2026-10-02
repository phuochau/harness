import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedProfile } from "../../src/config/profiles.js";
import {
  ChildPiPlanningPort,
  RoutedChildPiPlanningPort,
} from "../../src/pi/child-planning-port.js";
import type { ManagedProfileView } from "../../src/runtime/managed/materialize.js";
import type {
  PiLaunchSpec,
  PiProcessRecord,
  PiProcessSupervisor,
} from "../../src/runtime/pi-process/types.js";
import { sha256 } from "../../src/shared/sha256.js";
import {
  artifactPaths,
  planningProjectFixture,
  quickTaskDocumentFixture,
} from "../support/planning-fixtures.js";

class FakeSupervisor implements PiProcessSupervisor {
  public launches: PiLaunchSpec[] = [];
  public terminal = false;
  private record?: PiProcessRecord;

  public async launch(spec: PiLaunchSpec): Promise<PiProcessRecord> {
    this.launches.push(spec);
    this.record = {
      schemaVersion: 1,
      attemptId: spec.attemptId,
      attemptToken: spec.attemptToken,
      executable: spec.executable,
      argvHash: sha256(JSON.stringify(spec.argv)),
      cwd: spec.cwd,
      pid: 1234,
      startIdentity: "fake-start",
      sessionId: spec.sessionId,
      sessionDir: spec.sessionDir,
      eventsPath: join(spec.sessionDir, "events.jsonl"),
      stderrPath: join(spec.sessionDir, "stderr.log"),
      recordPath: join(spec.sessionDir, "process.json"),
      providerPath: join(spec.sessionDir, "provider.json"),
      receiptPublicKey: "fixture-public-key",
      startedAt: new Date(0).toISOString(),
    };
    return this.record!;
  }

  public async observe(record: PiProcessRecord) {
    if (!this.terminal) return { status: "running" as const, record };
    return {
      status: "exited" as const,
      exit: {
        exitCode: 0,
        signal: null,
        terminal: {
          settled: true,
          acceptedStopReason: true,
          completeToolResults: true,
          terminalEventHash: sha256("settled"),
        },
      },
    };
  }

  public async wait(record: PiProcessRecord) {
    this.terminal = true;
    const observed = await this.observe(record);
    if (observed.status !== "exited") throw new Error("not exited");
    return observed.exit;
  }

  public async cancel(record: PiProcessRecord) {
    return { attemptId: record.attemptId, signals: [], exit: null };
  }
}

const profile = {
  id: "planner-codex",
  family: "codex",
  runtime: "pi",
  provider: "openai-codex",
  model: "openai-codex/test",
  role: "planning",
  environment: "isolated",
  tools: ["read", "write"],
  extensions: [],
  skills: [],
  promptTemplates: [],
  contextFiles: false,
  mcp: [],
  hash: sha256("planner"),
} satisfies ResolvedProfile;

const managed = {
  extensionPaths: [],
  piSkillPaths: [],
  providerSkillPaths: [],
  promptTemplatePaths: [],
  environment: { HOME: "/managed/home", PATH: "/bin" },
  receiptHash: sha256("managed"),
} satisfies ManagedProfileView;

describe("ChildPiPlanningPort", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  async function fixture() {
    const project = await planningProjectFixture();
    cleanups.push(project.cleanup);
    const baseline: Record<string, string> = {};
    for (const path of Object.values(artifactPaths)) {
      try { baseline[path] = sha256(await readFile(join(project.root, path))); } catch {}
    }
    const supervisor = new FakeSupervisor();
    const sealer = {
      sealPlanningArtifacts: vi.fn(
        async (hashes: Readonly<Record<string, string>>) => ({
          commit: "b".repeat(40),
          hashes,
        }),
      ),
    };
    const port = new ChildPiPlanningPort({
      root: project.root,
      profile,
      managed,
      supervisor,
      piExecutable: "/bin/pi",
      transportExtensionPath: "/managed/transport.ts",
      sessionRoot: join(project.root, ".harness", "planning"),
      sealer,
    });
    return { project, baseline, supervisor, port, sealer };
  }

  function quickRequest(correlationId = "plan-F023-q1") {
    return {
      stage: "quick" as const,
      command: "/harness.quick-plan" as const,
      correlationId,
      artifactPaths,
      baseline: { hashes: {} },
      kind: "bugfix" as const,
      brief: "Fix the parser crash on empty input",
    };
  }

  async function writeQuickArtifacts(root: string, tasksText = quickTaskDocumentFixture()) {
    await writeFile(
      join(root, artifactPaths.spec),
      "# Specification\n\n- FR-001: Parser crash fixed\n- SC-001: Crash regression verified\n",
      "utf8",
    );
    await writeFile(
      join(root, artifactPaths.plan),
      "# Plan\n\nAdd a failing regression test, then fix the parser.\n",
      "utf8",
    );
    await writeFile(join(root, artifactPaths.tasks), tasksText, "utf8");
  }

  it("runs a correlated generation through planner-codex and records terminal proof", async () => {
    const run = await fixture();
    const request = {
      stage: "specify" as const,
      command: "/speckit.specify" as const,
      correlationId: "plan-F023-1",
      artifactPaths,
      baseline: { hashes: run.baseline },
    };
    const receipt = await run.port.enqueue(request);
    expect(run.supervisor.launches[0]?.argv).toContain("openai-codex");
    expect(run.supervisor.launches[0]?.argv.join(" ")).toContain("harness-planning:plan-F023-1");
    expect(await run.port.observe(receipt)).toEqual({ status: "pending" });
    await writeFile(join(run.project.root, artifactPaths.spec), "# Specification\n\n- FR-001: Changed\n- SC-001: Verified\n");
    run.supervisor.terminal = true;
    await expect(run.port.observe(receipt)).resolves.toMatchObject({
      status: "completed",
      receipt: {
        profileId: "planner-codex",
        profileHash: profile.hash,
        terminalEventHash: sha256("settled"),
        beforeHashes: { [artifactPaths.spec]: run.baseline[artifactPaths.spec] },
      },
    });
  });

  it("rejects unrelated artifact changes even after a valid terminal event", async () => {
    const run = await fixture();
    const receipt = await run.port.enqueue({
      stage: "specify",
      command: "/speckit.specify",
      correlationId: "plan-F023-2",
      artifactPaths,
      baseline: { hashes: run.baseline },
    });
    await writeFile(join(run.project.root, artifactPaths.spec), "# Specification\n\n- FR-001: Changed\n- SC-001: Verified\n");
    await writeFile(join(run.project.root, artifactPaths.plan), "# unrelated change\n");
    run.supervisor.terminal = true;
    await expect(run.port.observe(receipt)).resolves.toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/unexpected planning artifact changed/),
    });
  });

  it("does not accept artifacts written before a terminal event", async () => {
    const run = await fixture();
    const receipt = await run.port.enqueue({
      stage: "specify",
      command: "/speckit.specify",
      correlationId: "plan-F023-3",
      artifactPaths,
      baseline: { hashes: run.baseline },
    });
    await writeFile(join(run.project.root, artifactPaths.spec), "# Specification\n\n- FR-001: Changed\n- SC-001: Verified\n");
    await expect(run.port.observe(receipt)).resolves.toEqual({ status: "pending" });
  });

  it("passes an optional specify brief through as literal prompt text", async () => {
    const run = await fixture();
    await run.port.enqueue({
      stage: "specify",
      command: "/speckit.specify",
      correlationId: "plan-F023-4",
      artifactPaths,
      baseline: { hashes: run.baseline },
      brief: "A cached key parser",
    });
    expect(run.supervisor.launches[0]?.argv.join(" ")).toContain("A cached key parser");
  });

  it("sends the frozen kind and brief in one quick planning prompt", async () => {
    const run = await fixture();
    const request = quickRequest();
    const receipt = await run.port.enqueue(request);
    const prompt = run.supervisor.launches[0]?.argv.join(" ") ?? "";
    expect(prompt).toContain("harness-planning:plan-F023-q1");
    expect(prompt).toContain("Fix the parser crash on empty input");
    expect(prompt).toContain("bugfix");
    expect(prompt).toContain(artifactPaths.spec);
    expect(prompt).toContain(artifactPaths.tasks);
    await writeQuickArtifacts(run.project.root);
    run.supervisor.terminal = true;
    const observation = await run.port.observe(receipt);
    expect(observation).toMatchObject({
      status: "completed",
      artifacts: { commit: "b".repeat(40) },
    });
    expect(run.sealer.sealPlanningArtifacts).toHaveBeenCalledOnce();
  });

  it("blocks a quick child turn that produces more than one task", async () => {
    const run = await fixture();
    const receipt = await run.port.enqueue(quickRequest("plan-F023-q2"));
    await writeQuickArtifacts(
      run.project.root,
      quickTaskDocumentFixture({ extraTask: true }),
    );
    run.supervisor.terminal = true;
    await expect(run.port.observe(receipt)).resolves.toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/exactly one task/),
    });
    expect(run.sealer.sealPlanningArtifacts).not.toHaveBeenCalled();
  });
});

describe("RoutedChildPiPlanningPort", () => {
  it("routes the quick stage to the planning profile", async () => {
    const prepare = vi.fn(async () => ({ correlationId: "c", generation: 1 }));
    const enqueue = vi.fn(async () => ({ correlationId: "c", generation: 1 }));
    const observe = vi.fn(async () => ({ status: "pending" as const }));
    const port = { prepare, enqueue, observe } as unknown as ChildPiPlanningPort;
    const routed = new RoutedChildPiPlanningPort(
      { quick: "planner-codex", specify: "planner-codex" },
      { "planner-codex": port },
    );
    const request = {
      stage: "quick" as const,
      command: "/harness.quick-plan" as const,
      correlationId: "plan-q",
      artifactPaths,
      baseline: { hashes: {} },
      kind: "small-feature" as const,
      brief: "Add a flag",
    };
    await routed.prepare(request);
    expect(prepare).toHaveBeenCalledWith(request, undefined);
    await routed.enqueue(request);
    expect(enqueue).toHaveBeenCalledWith(request, undefined);
  });

  it("rejects a stage with no routed planning profile", () => {
    const routed = new RoutedChildPiPlanningPort({}, {});
    expect(() =>
      routed.enqueue({
        stage: "quick",
        command: "/harness.quick-plan",
        correlationId: "plan-q",
        artifactPaths,
        baseline: { hashes: {} },
        kind: "bugfix",
        brief: "x",
      }),
    ).toThrow(/no managed Pi planning profile/);
  });
});
