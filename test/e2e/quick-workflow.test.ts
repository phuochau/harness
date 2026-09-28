import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { compileWorkflow } from "../../src/config/compile.js";
import type { PiWorkerRuntime } from "../../src/runtime/pi-worker/runtime.js";
import { initializeProductionRun } from "../../src/runtime/production/run.js";
import { composeProductionRun } from "../../src/runtime/production/system.js";
import { compileRunSelection } from "../../src/pi/run-selection.js";
import { writeResolvedRunConfig } from "../../src/state/resolved-run-config.js";
import { createTempGitRepository } from "../support/git-fixtures.js";
import {
  fixtureCompileInput,
  fixtureResolvedProfiles,
  fixtureWorkflow,
} from "../support/factories.js";
import { quickTaskDocumentFixture } from "../support/planning-fixtures.js";
import {
  PullRequestProcess,
  SimulatedPiRuntime,
} from "../support/simulated-runtime.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

const commands = {
  task_verify: ["git", "status", "--porcelain"],
  full_verify: ["git", "status", "--porcelain"],
};

function fakePiSession(planningRoot: string, briefExpectation: string) {
  const entries: any[] = [];
  const appendEntry = (customType: string, data: unknown) => {
    entries.push({
      id: `entry-${entries.length + 1}`,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      type: "custom",
      customType,
      data,
    });
  };
  const sent: string[] = [];
  const interactiveModel = { provider: "anthropic", id: "interactive" };
  const planningModel = { provider: "openai-codex", id: "gpt-5.6-codex" };
  let selectedModel: typeof interactiveModel | typeof planningModel =
    interactiveModel;
  let thinkingLevel = "medium";
  const pi = {
    sent,
    appendEntry,
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    async setModel(model: typeof interactiveModel) {
      selectedModel = model;
      return true;
    },
    sendUserMessage(message: string) {
      sent.push(message);
      const marker = /harness-planning:([^:]+):(\d+)/.exec(message);
      if (
        marker === null ||
        !message.includes(briefExpectation) ||
        !message.includes("/harness.quick-plan")
      ) {
        throw new Error(`unexpected planning prompt: ${message.slice(0, 120)}`);
      }
      mkdirSync(join(planningRoot, "specs/feature"), { recursive: true });
      writeFileSync(
        join(planningRoot, "specs/feature/spec.md"),
        "# Specification\n\n- FR-001: Parser crash fixed\n- SC-001: Crash regression verified\n",
      );
      writeFileSync(
        join(planningRoot, "specs/feature/plan.md"),
        "# Plan\n\nAdd a failing regression test, then fix the parser.\n",
      );
      writeFileSync(
        join(planningRoot, "specs/feature/tasks.md"),
        quickTaskDocumentFixture({ ownedPaths: ["src/T001.txt"] }),
      );
      appendEntry("harness:planning-complete", {
        correlationId: marker[1],
        generation: Number(marker[2]),
        finalTurnIndex: 1,
      });
    },
  };
  const context = {
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => entries,
    },
    isIdle: () => true,
    get model() {
      return selectedModel;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [planningModel],
      hasConfiguredAuth: (model: unknown) => model === planningModel,
      find: (provider: string, id: string) =>
        [interactiveModel, planningModel].find(
          (model) => model.provider === provider && model.id === id,
        ),
    },
  } as const;
  return { pi, context, sent };
}

it("drives an approved bugfix run through one-turn planning and every downstream gate", async () => {
  const presetSource = await readFile(
    join(process.cwd(), "src/defaults/workflows/bugfix.yaml"),
    "utf8",
  );
  const repo = await createTempGitRepository("quick e2e", {
    ".harness/workflows/bugfix.yaml": presetSource,
  });
  const remote = await mkdtemp(join(tmpdir(), "pi-harness-remote-"));
  cleanup.push(async () => {
    await rm(remote, { recursive: true, force: true });
    await repo.cleanup();
  });
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["remote", "add", "origin", remote], { cwd: repo.path });

  const brief = "Fix the parser crash on empty input";
  const environment = {
    schema: "harness/environment/v1" as const,
    commands,
    pi_packages: [],
  };
  const workflow = await compileRunSelection(
    {
      root: repo.path,
      workflowDocument: fixtureWorkflow(),
      defaultWorkflow: compileWorkflow(fixtureCompileInput()),
      environment,
      profiles: fixtureResolvedProfiles(),
    },
    { kind: "bugfix", brief },
  );
  const artifactPaths = {
    spec: "specs/feature/spec.md",
    plan: "specs/feature/plan.md",
    tasks: "specs/feature/tasks.md",
    graph: "specs/feature/task-graph.json",
  } as const;
  const initialized = await initializeProductionRun({
    root: repo.path,
    runId: "F400",
    workflowRevision: workflow.revision,
    approvedPreviewHash: `sha256:${"a".repeat(64)}`,
    artifactPaths,
    remote: "origin",
    baseBranch: "main",
  });
  await writeResolvedRunConfig(initialized.paths.resolvedConfig, {
    schemaVersion: 1,
    runtime: {
      harnessVersion: "test",
      packageName: "pi-multi-agent-harness",
      packageVersion: "0.0.0-test",
      packageRoot: repo.path,
      transportHash: `sha256:${"c".repeat(64)}`,
      runtimeHash: `sha256:${"d".repeat(64)}`,
    },
    workflow,
    commands,
    selection: { kind: "bugfix", brief },
  });

  const planningRoot = join(initialized.paths.workers, "F400", "planning");
  const session = fakePiSession(planningRoot, brief);
  const piWorkers = new SimulatedPiRuntime();
  const pullRequests = new PullRequestProcess();
  const system = await composeProductionRun({
    initialized,
    workflow,
    artifactPaths,
    commands,
    pi: session.pi as any,
    context: session.context as any,
    piWorkerRuntime: piWorkers as unknown as PiWorkerRuntime,
    process: pullRequests,
  });
  try {
    await system.controller.enqueue({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "start:F400",
      payload: { operation: "run" },
    });
    await system.drain();
    const state = await system.readState();
    expect(state.planning).toMatchObject({ status: "completed", stage: "quick" });
    expect(state.jobs).toMatchObject({
      quick_plan: { state: "DONE" },
      "implement:T001": { state: "DONE" },
      "review:T001": { state: "DONE" },
      "verify:T001": { state: "DONE" },
      "integrate:T001": { state: "DONE" },
      "post_integrate_verify:T001": { state: "DONE" },
      "record_task_done:T001": { state: "DONE" },
      final_verify: { state: "DONE" },
      final_review: { state: "DONE" },
      push: { state: "DONE" },
      final_pr: { state: "DONE" },
    });
    expect(system.selection).toEqual({ kind: "bugfix", brief });
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]).toContain("/harness.quick-plan");
    expect(session.sent[0]).toContain(brief);
    expect(pullRequests.created).toBe(true);
    const events = (await readFile(initialized.paths.events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const completed = events.find(
      (event) => event.eventType === "planning.completed",
    );
    expect(completed.payload).toMatchObject({
      stage: "quick",
      commit: expect.any(String),
    });
    const runHead = await repo.repository.revParse(initialized.manifest.runRef);
    const graphJson = (
      await execa("git", ["show", `${runHead}:${artifactPaths.graph}`], {
        cwd: repo.path,
      })
    ).stdout;
    expect(JSON.parse(graphJson).tasks).toHaveLength(1);
  } finally {
    await system.dispose();
  }

  const recoveredSession = fakePiSession(planningRoot, brief);
  const recovered = await composeProductionRun({
    initialized,
    workflow,
    artifactPaths,
    commands,
    pi: recoveredSession.pi as any,
    context: recoveredSession.context as any,
    piWorkerRuntime: new SimulatedPiRuntime() as unknown as PiWorkerRuntime,
    process: new PullRequestProcess(),
  });
  try {
    await recovered.recover();
    const state = await recovered.readState();
    expect(state.jobs.final_pr?.state).toBe("DONE");
    expect(state.planning).toMatchObject({ status: "completed", stage: "quick" });
    expect(recovered.selection).toEqual({ kind: "bugfix", brief });
    expect(recoveredSession.sent).toHaveLength(0);
  } finally {
    await recovered.dispose();
  }
}, 30_000);
