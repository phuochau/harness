# Pi Orchestrator Phase 4: Spec Kit, Pi, and Runnable Defaults Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Connect deterministic orchestration to Spec Kit planning and a resident Pi extension, then generate a complete editable workflow that runs immediately.

**Architecture:** Spec Kit remains the planning source of truth. Pi planning actions are accepted only when their session/turn correlation and post-turn artifact hashes match the expected artifact set. The extension is tested through Pi's real resource loader before resident scheduling and commands are layered on it.

**Tech Stack:** Spec Kit presets, `@mariozechner/pi-coding-agent`, YAML, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Task 24: Ship the Spec Kit Graph Preset and Artifact Validator

**Files:**
- Create: `presets/harness-task-graph/preset.yml`
- Create: `presets/harness-task-graph/commands/speckit.tasks.md`
- Create: `presets/harness-task-graph/templates/task-graph.json`
- Create: `src/speckit/artifacts.ts`, `semantic-hash.ts`, `preset.ts`
- Create: `test/support/planning-fixtures.ts`
- Test: `test/integration/speckit/preset.test.ts`, `artifacts.test.ts`

**Interfaces:**
- Produces `validatePlanningArtifacts(root, expected, before): AcceptedArtifactSet`.
- Required files are `spec.md`, `plan.md`, `tasks.md`, and `task-graph.json`; acceptance binds path, content hash, and containing commit.

- [ ] **Step 1: Write preset composition and semantic-hash tests**

```ts
it("wraps speckit.tasks and emits a hash-bound graph", async () => {
  const resolved = await resolvePresetFixture("harness-task-graph");
  expect(resolved.command).toContain("{CORE_TEMPLATE}");
  const artifacts = await validatePlanningArtifacts(resolved.root, expectedArtifactPaths(), emptyArtifactBaseline());
  expect(artifacts.graph.tasksSemanticHash).toBe(semanticHash(artifacts.tasks.text));
});
```

- [ ] **Step 2: Run and observe missing preset/validator**

Run: `npm test -- test/integration/speckit/preset.test.ts test/integration/speckit/artifacts.test.ts`

Expected: FAIL.

- [ ] **Step 3: Create a real wrap preset and deterministic validator**

```yaml
# presets/harness-task-graph/preset.yml
id: harness-task-graph
version: 1
provides:
  commands:
    - name: speckit.tasks
      file: commands/speckit.tasks.md
      strategy: wrap
```

```md
---
description: Generate Spec Kit tasks and a deterministic harness task graph
---
{CORE_TEMPLATE}

After writing tasks.md, write task-graph.json using the supplied JSON template.
Copy every task ID and dependency exactly; compute tasksSemanticHash from the
normalized semantic task records. Do not invent dependencies during execution.
```

```ts
export async function validatePlanningArtifacts(root: string, expected: ArtifactPaths, before: ArtifactBaseline): Promise<AcceptedArtifactSet> {
  const loaded = await readExpectedFiles(root, expected);
  const hashes = hashArtifacts(loaded);
  if (Object.entries(hashes).every(([path, hash]) => before.hashes[path] === hash)) throw new PlanningArtifactError("no correlated artifact changed");
  const graph = validateTaskGraph(JSON.parse(loaded.graph.text));
  if (graph.tasksSemanticHash !== semanticHash(loaded.tasks.text)) throw new PlanningArtifactError("tasks semantic hash mismatch");
  return deepFreeze({ ...loaded, hashes, graph });
}
```

- [ ] **Step 4: Add immediate real Spec Kit compatibility test**

When `HARNESS_COMPAT_SPECKIT=1`, run `specify preset add --dev <absolute preset path>`, resolve `speckit.tasks`, and assert the wrapped core content and graph instruction are both present. This job is non-subscription and must run in the compatibility CI lane introduced in Task 34.

```ts
it.runIf(process.env.HARNESS_COMPAT_SPECKIT === "1")("resolves through the installed Spec Kit CLI", async () => {
  const project = await createDisposableSpecKitProject();
  await run("specify", ["preset", "add", "--dev", resolve("presets/harness-task-graph")], { cwd: project });
  const resolved = await run("specify", ["preset", "resolve", "speckit.tasks"], { cwd: project });
  expect(resolved.stdout).toContain("task-graph.json");
  expect(resolved.stdout).not.toContain("{CORE_TEMPLATE}");
});
```

Run: `HARNESS_COMPAT_SPECKIT=1 npm test -- test/integration/speckit/preset.test.ts`

Expected: PASS with the pinned Spec Kit CLI; normal unit CI skips explicitly.

- [ ] **Step 5: Commit**

```bash
git add presets src/speckit test/integration/speckit
git commit -m "feat: add Spec Kit task graph preset"
```

## Task 25: Correlate Pi Planning Turns with New Artifact Hashes

**Files:**
- Create: `src/ports/planning.ts`, `src/pi/planning-agent.ts`, `src/speckit/planning-action.ts`
- Modify: `test/support/planning-fixtures.ts`
- Test: `test/integration/speckit/planning-action.test.ts`

**Interfaces:**
- Produces `PlanningAgent.enqueue(request): Promise<PlanningTurnReceipt>` and `observe(receipt): Promise<PlanningObservation>`.
- Observation is `pending`, `completed` with accepted artifacts, or `blocked`; a bare Pi `turn_end` is insufficient.

- [ ] **Step 1: Write stale/unrelated-turn tests**

```ts
it("does not accept old artifacts after an unrelated turn ends", async () => {
  const fixture = await planningFixture({ existingArtifacts: validArtifactSet() });
  const receipt = await fixture.action.execute(fixture.request());
  fixture.pi.endTurn({ sessionId: receipt.sessionId, turnId: "other-turn" });
  await expect(fixture.action.observe(receipt)).resolves.toEqual({ status: "pending" });
});

it("accepts only new hashes from the correlated turn", async () => {
  const fixture = await planningFixture({ existingArtifacts: validArtifactSet() });
  const receipt = await fixture.action.execute(fixture.request());
  await fixture.writeCorrelatedArtifacts(receipt, changedArtifactSet());
  await expect(fixture.action.observe(receipt)).resolves.toMatchObject({ status: "completed", correlationId: receipt.correlationId });
});
```

- [ ] **Step 2: Run and observe missing planning action**

Run: `npm test -- test/integration/speckit/planning-action.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement correlation and baseline capture**

```ts
export interface PlanningRequest {
  command: "/speckit.specify" | "/speckit.plan" | "/speckit.tasks";
  correlationId: string;
  expectedPaths: readonly string[];
  baseline: ArtifactBaseline;
}

export type PlanningObservation =
  | { status: "pending" }
  | { status: "completed"; correlationId: string; artifacts: AcceptedArtifactSet }
  | { status: "blocked"; reason: string; evidence: string[] };

async observe(receipt: PlanningTurnReceipt): Promise<PlanningObservation> {
  const turn = await this.pi.findTurn(receipt.sessionId, receipt.turnId);
  if (!turn?.ended || turn.metadata.correlationId !== receipt.correlationId) return { status: "pending" };
  try {
    const artifacts = await validatePlanningArtifacts(this.root, turn.metadata.expectedPaths, turn.metadata.baseline);
    return { status: "completed", correlationId: receipt.correlationId, artifacts };
  } catch (error) {
    return { status: "blocked", reason: toMessage(error), evidence: [receipt.sessionId, receipt.turnId] };
  }
}
```

Existing-approved mode is separate: it skips Pi, validates paths/hashes, and binds the containing commit in one explicit action.

- [ ] **Step 4: Run correlation tests**

Run: `npm test -- test/integration/speckit/planning-action.test.ts`

Expected: PASS for unchanged files, wrong turn, changed wrong path, incomplete artifact set, valid correlated output, and explicit existing-approved mode.

- [ ] **Step 5: Commit**

```bash
git add src/ports/planning.ts src/pi/planning-agent.ts src/speckit/planning-action.ts test/integration/speckit/planning-action.test.ts
git commit -m "feat: correlate Pi planning artifacts"
```

## Task 26: Load the Extension Through Pi's Real Resource Loader

**Files:**
- Modify: `src/pi/extension.ts`
- Create: `src/pi/dependencies.ts`
- Test: `test/integration/pi-loader.test.ts`

**Interfaces:**
- Produces a default Pi extension factory that accepts injected dependencies for tests and production defaults otherwise.
- Compatibility uses `DefaultResourceLoader`, not a hand-written fake API.

- [ ] **Step 1: Write real loader compatibility test**

```ts
import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

it("loads the built extension through Pi's resource loader", async () => {
  const loader = new DefaultResourceLoader({ additionalExtensionPaths: [resolve("dist/pi/extension.js")] });
  await loader.reload();
  const diagnostics = loader.getDiagnostics();
  expect(diagnostics.errors).toEqual([]);
  expect(loader.getExtensions().length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Build and run; observe API mismatches**

```bash
npm run build
npm test -- test/integration/pi-loader.test.ts
```

Expected: FAIL until the extension matches the installed Pi API.

- [ ] **Step 3: Implement production dependency creation without side effects at import time**

```ts
export default function harnessExtension(pi: ExtensionAPI): void {
  const dependencies = createLazyExtensionDependencies();
  registerHarnessCommands(pi, dependencies);
  registerHarnessEvents(pi, dependencies);
}
```

Importing the module must not inspect a repository, connect to Herdr, create timers, or load state. Those actions occur only after Pi lifecycle events and are disposed on session shutdown.

- [ ] **Step 4: Add gated installed-Pi compatibility job**

```bash
HARNESS_COMPAT_PI=1 npm test -- test/integration/pi-loader.test.ts
```

Expected: PASS using the pinned peer version and current packaged output; no model turn or subscription is used.

- [ ] **Step 5: Commit**

```bash
git add src/pi/extension.ts src/pi/dependencies.ts test/integration/pi-loader.test.ts
git commit -m "feat: load extension through Pi runtime"
```

## Task 27: Generate a Complete Editable Default Workflow

**Files:**
- Create: `src/defaults/workflow.yaml`, `environment.yaml`, `policy.yaml`, `harness.lock`
- Create: `src/defaults/workflows/spec-kit-codex.yaml`, `spec-kit-devin.yaml`, `mixed-workers.yaml`
- Create: `src/cli/init.ts`, `command-detection.ts`, `config-merge.ts`, `package-root.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/support/planning-fixtures.ts`
- Test: `test/integration/init.test.ts`
- Fixtures: `test/fixtures/projects/node/`, `python/`

**Interfaces:**
- Produces `harness init [path] [--task-verify <argv-json>] [--full-verify <argv-json>]`.
- Every successful init produces schema-valid runnable YAML; no placeholder command is allowed.

- [ ] **Step 1: Write default and non-destructive init tests**

```ts
it("creates the full default stage sequence and all three workers", async () => {
  const repo = await copyProjectFixture("node");
  await runHarness(["init", repo]);
  const workflow = await loadYaml(join(repo, ".harness/workflow.yaml"));
  expect(workflow.stages.map((stage: { id: string }) => stage.id)).toEqual([
    "specify", "plan", "approve_plan", "tasks", "implement", "review", "verify", "integrate", "final_verify", "final_pr",
  ]);
  expect(workflow.stages.find((stage: { id: string }) => stage.id === "implement").runner.prefer).toEqual(["devin", "codex", "claude"]);
  expect(workflow.stages.find((stage: { id: string }) => stage.id === "review").runner.prefer).toEqual(["codex", "claude", "devin"]);
});

it("refuses to overwrite customized config", async () => {
  const repo = await initializedProject({ workflowName: "custom" });
  await expect(runHarness(["init", repo])).rejects.toThrow(/already exists/);
});
```

- [ ] **Step 2: Run and observe missing init command/defaults**

Run: `npm test -- test/integration/init.test.ts`

Expected: FAIL.

- [ ] **Step 3: Create the actual default workflow**

```yaml
schema: harness/v1
name: spec-kit-multi-agent
task_model:
  source: stages.tasks.outputs.graph
  complete_when: { stage: integrate }
stages:
  - id: specify
    uses: spec-kit.specify
    runner: pi
    model_profile: chatgpt-planning
  - id: plan
    uses: spec-kit.plan
    runner: pi
    model_profile: chatgpt-planning
    needs: [{ stage: specify, scope: all }]
  - id: approve_plan
    uses: human.approval
    needs: [{ stage: plan, scope: all }]
  - id: tasks
    uses: spec-kit.tasks
    runner: pi
    model_profile: chatgpt-planning
    needs: [{ stage: approve_plan, scope: all }]
    produces: { tasks: feature/tasks.md, graph: feature/task-graph.json }
  - id: implement
    uses: worker.execute
    runner: { prefer: [devin, codex, claude] }
    needs: [{ stage: tasks, scope: all }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    gate: task.dependencies_done
    isolation: worktree
    profile: disciplined-engineer
  - id: review
    uses: worker.review
    runner: { prefer: [codex, claude, devin] }
    needs: [{ stage: implement, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    policies: { require_different_worker_kind: true }
    on_failure: { changes_requested: { retry_stage: implement } }
  - id: verify
    uses: command.run
    needs: [{ stage: review, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    with: { command: "${commands.task_verify}" }
  - id: integrate
    uses: git.integrate
    needs: [{ stage: verify, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
  - id: final_verify
    uses: command.run
    needs: [{ stage: integrate, scope: all }]
    with: { command: "${commands.full_verify}" }
  - id: final_pr
    uses: github.pull-request
    needs: [{ stage: final_verify, scope: all }]
```

`environment.yaml` stores commands as argv arrays. `policy.yaml` protects planning/config paths and excludes production credentials. The lock pins `pi-multi-agent-harness`, Pi, Spec Kit, Superpowers, Herdr, integrations, and worker CLIs to exact source identities.

- [ ] **Step 4: Implement declarative detection and atomic generation**

```ts
export async function initProject(options: InitOptions): Promise<void> {
  const commands = options.commands ?? await detectCommandsFromManifests(options.root);
  if (!commands.taskVerify || !commands.fullVerify) throw new InitError("pass --task-verify and --full-verify as JSON argv arrays");
  const root = await findPackageRoot(import.meta.url, "pi-multi-agent-harness");
  const files = await renderDefaults(root, commands);
  await assertNoExistingTargets(options.root, Object.keys(files));
  await validateGeneratedConfiguration(files);
  await atomicWriteSet(options.root, files);
}
```

Read manifests only; never run npm scripts. Ambiguous/empty detection prompts interactively or fails noninteractively with exact flags. Resolve assets from `import.meta.url` and package metadata, never cwd.

- [ ] **Step 5: Commit after running init tests**

Run: `npm test -- test/integration/init.test.ts && npm run typecheck`

Expected: PASS for Node, Python, ambiguity, spaces, existing config, non-Git path, and packaged asset lookup.

```bash
git add src/defaults src/cli test/integration/init.test.ts test/fixtures/projects
git commit -m "feat: initialize runnable harness workflows"
```

## Task 28: Run Resident Scheduling and Semantic Commands in Pi

**Files:**
- Create: `src/pi/controller-registry.ts`, `events.ts`, `commands.ts`, `status-view.ts`, `planning-profile.ts`
- Modify: `src/pi/extension.ts`
- Modify: `test/support/planning-fixtures.ts`
- Test: `test/integration/pi-residency.test.ts`, `test/unit/pi-commands.test.ts`

**Interfaces:**
- Produces `/harness-run`, `status`, `graph`, `task`, `logs`, `retry`, `reroute`, `cancel`, `pause`, `resume`, and `doctor` commands.
- One controller exists per canonical run and every callback enqueues a `ControllerCommand`.

- [ ] **Step 1: Write idle-residency and command-queue tests**

```ts
it("advances while the Pi model is idle", async () => {
  const fixture = await piResidencyFixture({ modelIdle: true });
  await fixture.extension.startExistingRun("F023");
  fixture.herdr.emit(workerCompleted("implement:T001"));
  await fixture.clock.advanceBy(100);
  expect(fixture.controller.state.jobs["review:T001"].state).toBe("RUNNING");
  expect(fixture.pi.sentMessages).toHaveLength(0);
});

it("routes all wakeups through the serialized queue", async () => {
  const fixture = await piResidencyFixture();
  await Promise.all([fixture.pi.emit("turn_end"), fixture.herdr.emitAsync(agentIdle()), fixture.commands.retry("T001")]);
  expect(fixture.queue.maxConcurrent).toBe(1);
});
```

- [ ] **Step 2: Run and observe missing resident integration**

Run: `npm test -- test/integration/pi-residency.test.ts test/unit/pi-commands.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement registry, lifecycle hooks, and commands**

```ts
export class ControllerRegistry {
  #controllers = new Map<string, HarnessController>();
  async getOrRecover(run: ActiveRun): Promise<HarnessController> {
    const key = `${run.repositoryRoot}\0${run.runId}`;
    const existing = this.#controllers.get(key);
    if (existing) return existing;
    const controller = await this.factory.recover(run);
    this.#controllers.set(key, controller);
    return controller;
  }
}
```

Pi events, timer callbacks, Herdr subscriptions, and commands only create queue commands. `turn_end` wakes a receipt with matching planning metadata; it never advances arbitrary planning. Status commands read snapshots without model calls. Mutating commands append operator intents.

- [ ] **Step 4: Enforce planning profile and run approval boundaries**

Resolve `chatgpt-planning` from machine-local Pi settings, verify authenticated ChatGPT subscription capability, and restore the prior interactive model after the correlated planning turn. `/harness-run` displays workflow hash, commands, workers, credential profiles, permissions, branches, push, and PR effects before approval. Do not serialize credentials.

```ts
export async function withPlanningProfile<T>(pi: PiModelPort, action: () => Promise<T>): Promise<T> {
  const previous = await pi.currentModel();
  const planning = await pi.resolveAuthenticatedProfile("chatgpt-planning");
  if (!planning || planning.provider !== "openai-codex") throw new PolicyBlocker("CHATGPT_PLANNING_PROFILE_UNAVAILABLE");
  try {
    await pi.selectModel(planning);
    return await action();
  } finally {
    await pi.selectModel(previous);
  }
}
```

Run: `npm run check:phase4`

Expected: PASS, including real loader compatibility tests; no test starts a model turn unless explicitly gated.

- [ ] **Step 5: Commit and stop for milestone review**

```bash
git add src/pi src/cli/main.ts test/integration/pi-residency.test.ts test/unit/pi-commands.test.ts package.json package-lock.json
git commit -m "feat: host resident orchestration in Pi"
```
