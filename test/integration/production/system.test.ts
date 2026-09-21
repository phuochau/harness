import { mkdir, readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import { composeProductionRun } from "../../../src/runtime/production/system.js";
import { initializeProductionRun } from "../../../src/runtime/production/run.js";
import { createTempGitRepository } from "../../support/git-fixtures.js";

it("composes one fenced resident controller around an immutable production run", async () => {
  const repo = await createTempGitRepository("production system");
  let system: Awaited<ReturnType<typeof composeProductionRun>> | undefined;
  try {
    const root = process.cwd();
    const workflow = compileWorkflow({
      workflow: parse(await readFile(join(root, "src/defaults/workflow.yaml"), "utf8")),
      environment: parse(
        (await readFile(join(root, "src/defaults/environment.yaml"), "utf8"))
          .replace("__TASK_VERIFY__", '["npm", "test"]')
          .replace("__FULL_VERIFY__", '["npm", "test"]'),
      ),
    });
    const artifacts = {
      spec: "specs/feature/spec.md",
      plan: "specs/feature/plan.md",
      tasks: "specs/feature/tasks.md",
      graph: "specs/feature/task-graph.json",
    } as const;
    const initialized = await initializeProductionRun({
      root: repo.path,
      runId: "F200",
      workflowRevision: workflow.revision,
      approvedPreviewHash: `sha256:${"a".repeat(64)}`,
      artifactPaths: artifacts,
      remote: "origin",
      baseBranch: "main",
    });
    const fakeHerdr = {
      request: async () => ({ workspaces: [] }),
      subscribe: () => () => undefined,
      close: () => undefined,
    };
    const entries: any[] = [];
    const context = {
      isIdle: () => true,
      sessionManager: {
        getSessionFile: () => "/tmp/pi-session.jsonl",
        getLeafId: () => entries.at(-1)?.id ?? null,
        getBranch: () => entries,
      },
    };
    system = await composeProductionRun({
      initialized,
      workflow,
      artifactPaths: artifacts,
      commands: { task_verify: ["npm", "test"], full_verify: ["npm", "test"] },
      pi: { appendEntry() {}, sendUserMessage() {} } as any,
      context: context as any,
      ensureHerdr: async () => fakeHerdr as any,
    });
    await expect(system.readState()).resolves.toMatchObject({
      runId: "F200",
      workflowRevision: workflow.revision,
      lastSequence: 1,
    });
    expect(system.graph().order).toEqual([]);
  } finally {
    await system?.dispose();
    await repo.cleanup();
  }
});

it("drives a correlated Pi planning stage through the resident durable controller", async () => {
  const repo = await createTempGitRepository("resident planning");
  let system: Awaited<ReturnType<typeof composeProductionRun>> | undefined;
  try {
    const artifacts = {
      spec: "specs/feature/spec.md",
      plan: "specs/feature/plan.md",
      tasks: "specs/feature/tasks.md",
      graph: "specs/feature/task-graph.json",
    } as const;
    const workflow = compileWorkflow({
      environment: { schema: "harness/environment/v1", commands: {}, pi_packages: [] },
      workflow: {
        schema: "harness/v1",
        name: "planning-only",
        task_model: {
          source: "stages.specify.outputs.spec",
          complete_when: { stage: "specify" },
        },
        stages: [{
          id: "specify",
          uses: "spec-kit.specify",
          runner: "pi",
          produces: { spec: artifacts.spec },
        }],
      },
    });
    const initialized = await initializeProductionRun({
      root: repo.path,
      runId: "F201",
      workflowRevision: workflow.revision,
      approvedPreviewHash: `sha256:${"a".repeat(64)}`,
      artifactPaths: artifacts,
      remote: "origin",
      baseBranch: "main",
    });
    const entries: any[] = [];
    const sessionManager = {
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => entries,
    };
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
    const interactiveModel = { provider: "anthropic", id: "interactive" };
    const planningModel = { provider: "openai-codex", id: "gpt-5.6-codex" };
    let selectedModel = interactiveModel;
    let thinkingLevel = "medium";
    const planningRoot = join(initialized.paths.workers, "F201", "planning");
    const pi = {
      appendEntry,
      getThinkingLevel: () => thinkingLevel,
      setThinkingLevel(level: string) { thinkingLevel = level; },
      async setModel(model: typeof interactiveModel) {
        selectedModel = model;
        return true;
      },
      sendUserMessage(message: string) {
        mkdirSync(join(planningRoot, "specs/feature"), { recursive: true });
        writeFileSync(join(planningRoot, artifacts.spec), "# Spec\n\n- FR-001: Fixture\n");
        const marker = /harness-planning:([^:]+):(\d+)/.exec(message)!;
        appendEntry("harness:planning-complete", {
          correlationId: marker[1],
          generation: Number(marker[2]),
          finalTurnIndex: 1,
        });
      },
    };
    system = await composeProductionRun({
      initialized,
      workflow,
      artifactPaths: artifacts,
      commands: {},
      pi: pi as any,
      context: {
        sessionManager,
        isIdle: () => true,
        get model() { return selectedModel; },
        get thinkingLevel() { return thinkingLevel; },
        scopedModels: [],
        modelRegistry: {
          getAvailable: () => [planningModel],
          hasConfiguredAuth: (model: typeof planningModel) => model === planningModel,
          find: (provider: string, id: string) =>
            [interactiveModel, planningModel].find(
              (model) => model.provider === provider && model.id === id,
            ),
        },
      } as any,
      ensureHerdr: async () => ({
        request: async () => ({ workspaces: [] }),
        subscribe: () => () => undefined,
        close: () => undefined,
      }) as any,
    });
    await system.controller.enqueue({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "start:F201",
      payload: { operation: "run" },
    });
    await system.drain();
    await expect(system.readState()).resolves.toMatchObject({
      jobs: { specify: { state: "DONE", attempt: 1, worker: "pi" } },
      planning: { status: "completed", stage: "specify" },
    });
  } finally {
    await system?.dispose();
    await repo.cleanup();
  }
});
