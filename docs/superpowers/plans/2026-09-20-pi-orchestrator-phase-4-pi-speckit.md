# Pi Orchestrator Phase 4: Spec Kit, Pi, and Runnable Defaults Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Connect deterministic orchestration to Spec Kit planning and a resident Pi extension, then generate a complete editable workflow that runs immediately.

**Architecture:** Spec Kit remains the planning source of truth. Pi planning actions are accepted only when a durable custom-entry marker, the correlated agent run reaches `agent_settled`, its final `turnIndex` is recorded, and stage-specific artifact deltas agree. The extension is tested through Pi's real resource loader before resident scheduling and commands are layered on it.

**Tech Stack:** Spec Kit presets, `@earendil-works/pi-coding-agent@0.86.1`, YAML, TypeScript, Vitest.

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
- Produces `planningArtifactContract(stage, paths)` and `validatePlanningArtifacts(root, contract, before): AcceptedStageArtifacts`.
- `specify` requires a changed `spec.md`; `plan` requires existing spec plus changed `plan.md`; `tasks` requires the complete set and changed `tasks.md` plus `task-graph.json`.

- [ ] **Step 1: Write preset composition and semantic-hash tests**

```ts
it("wraps speckit.tasks and emits a hash-bound graph", async () => {
  const resolved = await resolvePresetFixture("harness-task-graph");
  expect(resolved.command).toContain("{CORE_TEMPLATE}");
  const artifacts = await validatePlanningArtifacts(resolved.root, planningArtifactContract("tasks", artifactPathsFixture()), emptyArtifactBaseline());
  expect(artifacts.graph?.tasksSemanticHash).toBe(semanticHash(artifacts.files.tasks.text));
});
```

- [ ] **Step 2: Run and observe missing preset/validator**

Run: `npm test -- test/integration/speckit/preset.test.ts test/integration/speckit/artifacts.test.ts`

Expected: FAIL.

- [ ] **Step 3: Create a real wrap preset and deterministic validator**

```yaml
# presets/harness-task-graph/preset.yml
schema_version: "1.0"
preset:
  id: harness-task-graph
  name: Harness Task Graph
  version: "1.0.0"
  description: Add a deterministic harness task graph to speckit.tasks
  author: pi-multi-agent-harness
  license: MIT
requires:
  speckit_version: ">=0.1.0"
provides:
  templates:
    - type: command
      name: speckit.tasks
      file: commands/speckit.tasks.md
      description: Generate tasks.md and a hash-bound harness task graph
      strategy: wrap
tags: [orchestration, task-graph]
```

```md
---
description: Generate Spec Kit tasks and a deterministic harness task graph
strategy: wrap
---
{CORE_TEMPLATE}

After writing tasks.md, write task-graph.json using the supplied JSON template.
Copy every task ID and dependency exactly; compute tasksSemanticHash from the
normalized semantic task records. Do not invent dependencies during execution.
```

```ts
export function planningArtifactContract(stage: PlanningStage, paths: ArtifactPaths): PlanningArtifactContract {
  if (stage === "specify") return { paths, required: ["spec"], mustChange: ["spec"], validateGraph: false };
  if (stage === "plan") return { paths, required: ["spec", "plan"], mustChange: ["plan"], validateGraph: false };
  return { paths, required: ["spec", "plan", "tasks", "graph"], mustChange: ["tasks", "graph"], validateGraph: true };
}

export async function validatePlanningArtifacts(root: string, contract: PlanningArtifactContract, before: ArtifactBaseline): Promise<AcceptedStageArtifacts> {
  const loaded = await readRequiredFiles(root, contract.paths, contract.required);
  const hashes = hashArtifacts(loaded);
  for (const name of contract.mustChange) {
    if (before.hashes[loaded[name].path] === hashes[loaded[name].path]) throw new PlanningArtifactError(`${name} did not change in the correlated turn`);
  }
  const graph = contract.validateGraph ? validateTaskGraph(JSON.parse(loaded.graph.text)) : undefined;
  if (graph && graph.tasksSemanticHash !== semanticHash(loaded.tasks.text)) throw new PlanningArtifactError("tasks semantic hash mismatch");
  return deepFreeze({ files: loaded, hashes, graph });
}
```

- [ ] **Step 4: Add immediate real Spec Kit compatibility test**

When `HARNESS_COMPAT_SPECKIT=1`, run `specify preset add --dev <absolute preset path>`, resolve `speckit.tasks`, and assert the wrapped core content and graph instruction are both present. This job is non-subscription and must run in the compatibility CI lane introduced in Task 34.

```ts
it.runIf(process.env.HARNESS_COMPAT_SPECKIT === "1")("resolves through the installed Spec Kit CLI", async () => {
  const project = await createDisposableSpecKitProject({ integration: "claude", aiSkills: false });
  await run("specify", ["preset", "add", "--dev", resolve("presets/harness-task-graph")], { cwd: project });
  const resolved = await run("specify", ["preset", "resolve", "speckit.tasks"], { cwd: project });
  expect(resolved.stdout).toContain("harness-task-graph");
  const materialized = await readFile(join(project, ".claude/commands/speckit.tasks.md"), "utf8");
  expect(materialized).toContain("task-graph.json");
  expect(materialized).not.toContain("{CORE_TEMPLATE}");
});
```

Run: `HARNESS_COMPAT_SPECKIT=1 npm test -- test/integration/speckit/preset.test.ts`

Expected: PASS with the pinned Spec Kit CLI; normal unit CI skips explicitly.

- [ ] **Step 5: Commit**

```bash
git add presets src/speckit test/integration/speckit
git commit -m "feat: add Spec Kit task graph preset"
```

## Task 25: Correlate Pi Planning Runs with New Artifact Hashes

**Files:**
- Create: `src/ports/planning.ts`, `src/pi/planning-agent.ts`, `src/speckit/planning-action.ts`
- Modify: `test/support/planning-fixtures.ts`
- Test: `test/integration/speckit/planning-action.test.ts`

**Interfaces:**
- Produces `PlanningAgent.enqueue(request, context): Promise<PlanningRunReceipt>` and `observe(receipt): Promise<PlanningObservation>`.
- Observation is `pending`, `completed` with accepted artifacts, or `blocked`; a bare Pi `turn_end` is insufficient because one agent run may contain multiple tool turns.

- [ ] **Step 1: Write stale/unrelated-turn tests**

```ts
it("does not accept old artifacts after an unrelated turn ends", async () => {
  const fixture = await planningFixture({ existingArtifacts: validArtifactSet() });
  const receipt = await fixture.action.execute(fixture.request());
  fixture.pi.emitTurn({ turnIndex: 7, prompt: "ordinary user turn", correlated: false });
  await expect(fixture.action.observe(receipt)).resolves.toEqual({ status: "pending" });
});

it("accepts only new hashes from the correlated turn", async () => {
  const fixture = await planningFixture({ existingArtifacts: validArtifactSet() });
  const receipt = await fixture.action.execute(fixture.request());
  await fixture.pi.completeCorrelatedRun(receipt, changedArtifactSet());
  await expect(fixture.action.observe(receipt)).resolves.toMatchObject({ status: "completed", correlationId: receipt.correlationId });
});

it("seals the final tasks artifact set on the run branch", async () => {
  const fixture = await planningFixture({ stage: "tasks" });
  const receipt = await fixture.action.execute(fixture.request());
  await fixture.pi.completeCorrelatedRun(receipt, changedArtifactSet());
  const observation = await fixture.action.observe(receipt);
  expect(observation).toMatchObject({ status: "completed", artifacts: { commit: expect.any(String) } });
  expect(fixture.git.calls("sealPlanningArtifacts")).toHaveLength(1);
});
```

- [ ] **Step 2: Run and observe missing planning action**

Run: `npm test -- test/integration/speckit/planning-action.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement correlation and baseline capture**

```ts
export interface PlanningRequest {
  stage: "specify" | "plan" | "tasks";
  command: "/speckit.specify" | "/speckit.plan" | "/speckit.tasks";
  correlationId: string;
  artifactPaths: ArtifactPaths;
  baseline: ArtifactBaseline;
}

export type PlanningObservation =
  | { status: "pending" }
  | { status: "completed"; correlationId: string; artifacts: AcceptedArtifactSet }
  | { status: "blocked"; reason: string; evidence: string[] };

async observe(receipt: PlanningRunReceipt): Promise<PlanningObservation> {
  const markers = await this.pi.findRunMarkers(receipt.sessionFile, receipt.requestEntryId, receipt.correlationId);
  if (!markers.started || !markers.settled || markers.settled.finalTurnIndex < markers.started.firstTurnIndex) return { status: "pending" };
  const pending = await this.pendingPlanning.get(receipt.correlationId);
  if (!pending) return { status: "blocked", reason: "missing durable planning request", evidence: [receipt.correlationId] };
  try {
    const stageArtifacts = await validatePlanningArtifacts(this.root, planningArtifactContract(pending.stage, pending.artifactPaths), pending.baseline);
    const artifacts = pending.stage === "tasks"
      ? await this.worktrees.sealPlanningArtifacts(this.planningWorktree, stageArtifacts.hashes)
      : stageArtifacts;
    return { status: "completed", correlationId: receipt.correlationId, artifacts };
  } catch (error) {
    return { status: "blocked", reason: toMessage(error), evidence: [receipt.sessionFile, receipt.requestEntryId, String(markers.settled.finalTurnIndex)] };
  }
}
```

`PlanningAgent.enqueue` requires an idle, persistent session and one pending
planning action at a time. It calls
`pi.appendEntry("harness:planning-request", request)`, captures the resulting
`ctx.sessionManager.getLeafId()` as `requestEntryId`, and then calls
`pi.sendUserMessage()` with `expandPromptTemplates: true` and an embedded
correlation marker. `before_agent_start` recognizes that marker; the first
`turn_start` appends a durable `harness:planning-start` entry. Matching
`turn_end` events update the last completed index, and only `agent_settled`
appends `harness:planning-complete` with that final index. On restart, observation scans
`ctx.sessionManager.getEntries()` after `requestEntryId`. A changed file without
the durable completion entry remains pending and is never accepted.

Existing-approved mode is separate: it skips Pi, validates the complete paths
and hashes, requires a clean containing commit, and binds that commit in one
explicit action.

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
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

it("loads the built extension through Pi's resource loader", async () => {
  const loader = new DefaultResourceLoader({ additionalExtensionPaths: [resolve("dist/pi/extension.js")] });
  await loader.reload();
  const result = loader.getExtensions();
  expect(result.errors).toEqual([]);
  expect(result.extensions.length).toBeGreaterThan(0);
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
    with: { argv: "${commands.task_verify}" }
  - id: integrate
    uses: git.integrate
    needs: [{ stage: verify, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
  - id: final_verify
    uses: command.run
    needs: [{ stage: integrate, scope: all }]
    with: { argv: "${commands.full_verify}" }
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
- Produces `/harness-run`, `/harness-status`, `/harness-graph`, `/harness-task`, `/harness-logs`, `/harness-retry`, `/harness-reroute`, `/harness-cancel`, `/harness-pause`, `/harness-resume`, and `/harness-doctor` commands.
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

Pi events, timer callbacks, Herdr subscriptions, and commands only create queue
commands. The planning event state machine records the correlation marker at
`before_agent_start`, tracks the correlated run's `turnIndex` values, and
appends a durable completion entry only at `agent_settled`; intermediate or
arbitrary turns cannot advance
planning. Status commands read snapshots without model calls. Mutating commands
append operator intents.

- [ ] **Step 4: Enforce planning profile and run approval boundaries**

Resolve `chatgpt-planning` from machine-local Pi settings, verify authenticated ChatGPT subscription capability, and restore the prior interactive model after the correlated planning run settles. `/harness-run` displays workflow hash, commands, workers, credential profiles, permissions, branches, push, and PR effects before approval. Do not serialize credentials.

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
