import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileWorkflow } from "../../src/config/compile.js";
import type { ControllerCommand } from "../../src/contracts/controller-command.js";
import { ControllerCommandQueue } from "../../src/controller/command-queue.js";
import { HarnessController } from "../../src/controller/controller.js";
import { ProjectCommandBackend } from "../../src/pi/dependencies.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import { sha256 } from "../../src/shared/sha256.js";
import { resolveRunPaths } from "../../src/state/paths.js";
import { readResolvedRunConfig } from "../../src/state/resolved-run-config.js";
import type { ManagedPiRuntimeBundle } from "../../src/runtime/managed/factory.js";
import type { ManagedProfileView } from "../../src/runtime/managed/materialize.js";
import { createTempGitRepository } from "../support/git-fixtures.js";
import {
  fixtureCompileInput,
  fixtureEnvironment,
  fixtureResolvedProfiles,
  fixtureWorkflow,
} from "../support/factories.js";
import type { PiProcessRecord, PiProcessSupervisor } from "../../src/runtime/pi-process/types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

class PendingSupervisor implements PiProcessSupervisor {
  public launches: unknown[] = [];
  public async launch(spec: {
    attemptId: string;
    attemptToken: string;
    cwd: string;
  }): Promise<PiProcessRecord> {
    this.launches.push(spec);
    return {
      schemaVersion: 1,
      attemptId: spec.attemptId,
      attemptToken: spec.attemptToken,
      executable: "/bin/pi",
      argvHash: `sha256:${"f".repeat(64)}`,
      cwd: spec.cwd,
      pid: process.pid,
      startIdentity: "test",
      sessionId: "test-session",
      sessionDir: "/tmp/test-session",
      eventsPath: "/tmp/test-session/events.jsonl",
      stderrPath: "/tmp/test-session/stderr.log",
      recordPath: "/tmp/test-session/record.json",
      providerPath: "/tmp/test-session/provider.json",
      receiptPublicKey: "test-key",
      startedAt: new Date().toISOString(),
    };
  }
  public async observe(
    record: PiProcessRecord,
  ): Promise<{ status: "running"; record: PiProcessRecord }> {
    return { status: "running", record };
  }
  public async wait(): Promise<never> {
    return new Promise(() => {});
  }
  public async cancel(record: PiProcessRecord) {
    return { attemptId: record.attemptId, signals: [] as const, exit: null };
  }
}

function runCommand(key: string, payload: Record<string, unknown>): ControllerCommand {
  return {
    schemaVersion: 1,
    source: "operator",
    kind: "operator_intent",
    idempotencyKey: key,
    payload: { operation: "run", ...payload },
  };
}

async function backendFixture() {
  const presetSource = await readFile(
    join(process.cwd(), "src/defaults/workflows/bugfix.yaml"),
    "utf8",
  );
  const repo = await createTempGitRepository("approval", {
    ".harness/workflows/bugfix.yaml": presetSource,
  });
  const profiles = fixtureResolvedProfiles();
  const managedView: ManagedProfileView = {
    extensionPaths: [],
    piSkillPaths: [],
    providerSkillPaths: [],
    promptTemplatePaths: [],
    environment: { HOME: "/managed/home", PATH: "/bin" },
    receiptHash: `sha256:${"e".repeat(64)}`,
  };
  const supervisor = new PendingSupervisor();
  const runtime = {
    profiles,
    managedProfiles: Object.fromEntries(
      Object.keys(profiles.byId).map((id) => [id, managedView]),
    ),
    supervisor,
    piExecutable: "/bin/pi",
    piExecutableArgs: [],
    transportExtensionPath: "/managed/transport.ts",
    workerRuntime: {
      prepare: vi.fn(),
      launch: vi.fn(),
      collect: vi.fn(),
      recover: vi.fn(),
      observe: vi.fn(),
      cancel: vi.fn(),
    },
  } as unknown as ManagedPiRuntimeBundle;
  const environment = fixtureEnvironment();
  const backend = new ProjectCommandBackend(
    repo.path,
    new HarnessController(
      new ControllerCommandQueue({
        accept: async () => ({ commandKey: "unused" }),
        processReceived: async () => ({ commandKey: "unused", stateRevision: 0 }),
        pendingCommandKeysInSequenceOrder: async () => [],
      }),
    ),
    { appendEntry: vi.fn(), sendUserMessage: vi.fn() } as any,
    {
      sessionManager: {
        getSessionFile: () => "/tmp/session.jsonl",
        getLeafId: () => null,
        getBranch: () => [],
      },
      isIdle: () => true,
    } as any,
    {
      workflow: compileWorkflow(fixtureCompileInput()),
      workflowDocument: fixtureWorkflow(),
      environment,
      commands: environment.commands,
      permissions: [],
      runtime,
      runtimeVersion: "test",
      packageRoot: repo.path,
      packageName: "pi-multi-agent-harness",
      packageVersion: "0.0.0-test",
      transportHash: `sha256:${"c".repeat(64)}`,
      runtimeHash: `sha256:${"d".repeat(64)}`,
    },
  );
  cleanups.push(async () => {
    await backend.dispose();
    await repo.cleanup();
  });
  return { backend, repo, supervisor };
}

describe("run approval through the real enqueue path", () => {
  it("rejects an approval hash bound to a different kind", async () => {
    const { backend } = await backendFixture();
    const legacy = await backend.previewRun({ kind: "large-feature" });
    const staleHash = sha256(canonicalJson(legacy));
    await expect(
      backend.enqueue(
        runCommand("stale:kind", {
          target: "F500",
          kind: "bugfix",
          brief: "Fix the parser crash",
          approvedPreviewHash: staleHash,
        }),
      ),
    ).rejects.toThrow(/does not match the current frozen preview/);
  });

  it("rejects an approval when the preset changed after preview", async () => {
    const { backend, repo } = await backendFixture();
    const brief = "Fix the parser crash";
    const preview = await backend.previewRun({ kind: "bugfix", brief });
    const approvedHash = sha256(canonicalJson(preview));
    const presetPath = join(repo.path, ".harness/workflows/bugfix.yaml");
    const original = await readFile(presetPath, "utf8");
    await writeFile(
      presetPath,
      original.replace("name: spec-kit-bugfix", "name: spec-kit-bugfix-drifted"),
      "utf8",
    );
    await expect(
      backend.enqueue(
        runCommand("stale:preset", {
          target: "F500",
          kind: "bugfix",
          brief,
          approvedPreviewHash: approvedHash,
        }),
      ),
    ).rejects.toThrow(/does not match the current frozen preview/);
  });

  it("freezes the approved kind and brief into the resolved run config", async () => {
    const { backend, repo } = await backendFixture();
    const brief = "Fix the parser crash on empty input";
    const preview = await backend.previewRun({ kind: "bugfix", brief });
    const approvedHash = sha256(canonicalJson(preview));
    await backend.enqueue(
      runCommand("fresh:bugfix", {
        target: "F500",
        kind: "bugfix",
        brief,
        approvedPreviewHash: approvedHash,
      }),
    );
    const paths = await resolveRunPaths(repo.path, "F500");
    const resolved = await readResolvedRunConfig(paths.resolvedConfig);
    expect(resolved.selection).toEqual({ kind: "bugfix", brief });
    const events = (await readFile(paths.events, "utf8")).trim();
    expect(events).toContain("run.created");
  });

  it("refuses to reclassify or start a second run while one is active", async () => {
    const { backend } = await backendFixture();
    const brief = "Fix the parser crash";
    const preview = await backend.previewRun({ kind: "bugfix", brief });
    const approvedHash = sha256(canonicalJson(preview));
    await backend.enqueue(
      runCommand("active:bugfix", {
        target: "F500",
        kind: "bugfix",
        brief,
        approvedPreviewHash: approvedHash,
      }),
    );
    await expect(
      backend.enqueue(
        runCommand("active:reclassify", {
          target: "F600",
          kind: "small-feature",
          brief: "Add a parser option",
          approvedPreviewHash: approvedHash,
        }),
      ),
    ).rejects.toThrow(/already active/);
    await expect(
      backend.enqueue(runCommand("active:legacy", { target: "F601" })),
    ).rejects.toThrow(/already active/);
  });
});
