import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../../src/config/profiles.js";
import { ChildPiPlanningPort } from "../../src/pi/child-planning-port.js";
import type { ManagedProfileView } from "../../src/runtime/managed/materialize.js";
import type {
  PiLaunchSpec,
  PiProcessRecord,
  PiProcessSupervisor,
} from "../../src/runtime/pi-process/types.js";
import { sha256 } from "../../src/shared/sha256.js";
import { artifactPaths, planningProjectFixture } from "../support/planning-fixtures.js";

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
      startedAt: new Date(0).toISOString(),
    };
    return this.record;
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
    const port = new ChildPiPlanningPort({
      root: project.root,
      profile,
      managed,
      supervisor,
      piExecutable: "/bin/pi",
      transportExtensionPath: "/managed/transport.ts",
      sessionRoot: join(project.root, ".harness", "planning"),
    });
    return { project, baseline, supervisor, port };
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
});
