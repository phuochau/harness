# Pi Orchestrator Phase 4: Spec Kit, Pi, and Runnable Defaults Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Connect deterministic orchestration to Spec Kit planning and a resident Pi extension, then generate a complete editable workflow that runs immediately.

**Architecture:** Spec Kit remains the planning source of truth. Pi planning actions are accepted only when a durable custom-entry marker identifies either the correlated `agent_settled` callback or a strictly validated recovered terminal transcript, its final `turnIndex` is recorded, and stage-specific artifact deltas agree. A correlation-bound profile lease keeps the authenticated planning model selected through that terminal boundary and restores the prior interactive model idempotently. Controller code derives the task graph and cryptographic hash from exact-grammar canonical `tasks.md` records. The extension is tested through Pi's real resource loader before resident scheduling and commands are layered on it.

**Tech Stack:** Spec Kit presets, `@earendil-works/pi-coding-agent@0.86.1`, YAML, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Task 24: Ship the Spec Kit Graph Preset and Artifact Validator

**Files:**
- Create: `presets/harness-task-graph/preset.yml`
- Create: `presets/harness-task-graph/commands/speckit.tasks.md`
- Create: `src/speckit/artifacts.ts`, `task-records.ts`, `semantic-hash.ts`, `seal-task-graph.ts`, `preset.ts`
- Create: `test/support/planning-fixtures.ts`
- Test: `test/integration/speckit/preset.test.ts`, `artifacts.test.ts`

**Interfaces:**
- Produces `parseSpecKitTasks(text): CanonicalTaskRecord[]`, `sealTaskGraph(input): TaskGraphDocument`, `planningArtifactContract(stage, paths)`, and `validatePlanningArtifacts(root, contract, before): AcceptedStageArtifacts`.
- `specify` requires a changed `spec.md`; `plan` requires existing spec plus changed `plan.md`; `tasks` requires the complete set and a changed `tasks.md`, then the controller atomically derives and validates `task-graph.json`.

- [ ] **Step 1: Write preset composition and semantic-hash tests**

```ts
it("wraps speckit.tasks and emits a hash-bound graph", async () => {
  const resolved = await resolvePresetFixture("harness-task-graph");
  expect(resolved.command).toContain("{CORE_TEMPLATE}");
  const artifacts = await validatePlanningArtifacts(resolved.root, planningArtifactContract("tasks", artifactPathsFixture()), emptyArtifactBaseline());
  expect(resolved.command).toContain("harness-task-metadata:v1");
  expect(artifacts.graph?.schema).toBe("harness/task-graph/v1");
  expect(artifacts.graph?.tasksSemanticHash).toBe(semanticHash(parseSpecKitTasks(artifacts.files.tasks.text)));
});

it("rejects metadata that disagrees with the visible task definition", async () => {
  await expect(sealTaskGraph(taskArtifactFixture({ metadataOwnedPath: "src/wrong.ts" })))
    .rejects.toThrow(/metadata does not match visible task/);
});

it("parses the exact visible grammar and ignores only checkbox state", () => {
  const unchecked = exactTaskDocumentFixture({ checkbox: " " });
  const checked = exactTaskDocumentFixture({ checkbox: "x" });
  expect(parseSpecKitTasks(unchecked)).toEqual(parseSpecKitTasks(checked));
  expect(parseSpecKitTasks(unchecked)[0]).toMatchObject({
    id: "T001", phase: "Setup", labels: ["US1"], parallelEligible: true,
    dependsOn: [], acceptanceRefs: ["FR-001"], ownedPaths: ["src/parser.ts"],
  });
});

it.each([
  "missing_metadata_delimiter", "duplicate_json_key", "unknown_visible_syntax",
  "metadata_task_order_mismatch", "duplicate_set_member", "non_posix_path",
] as const)("rejects malformed task contract %s", (kind) => {
  expect(() => parseSpecKitTasks(malformedTaskDocumentFixture(kind))).toThrow();
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

Render every phase heading as `## Phase N: <name>` and every task as exactly:

`- [ ] T001 [P] [US1] Description | deps=[] | ac=["FR-001"] | paths=["src/file.ts"]`

`[P]` and labels are optional; the three pipe fields are required JSON string
arrays. Escape a literal description pipe as `\|`. Then append exactly one EOF
block with no content after it:

<!-- harness-task-metadata:v1
{"schema":"harness/task-metadata/v1","tasks":[{"acceptanceRefs":["FR-001"],"dependsOn":[],"description":"Description","id":"T001","labels":["US1"],"ownedPaths":["src/file.ts"],"parallelEligible":true,"phase":"<name>"}]}
-->

Include one metadata record per visible task in visible order and copy every
field from the visible entry after normalization. Emit the JSON line as
canonical JSON: object keys sorted by locale-independent UTF-16 code-unit order, no insignificant
whitespace, and already-normalized arrays. Do not write
`task-graph.json` and do not compute a hash: the harness controller derives both
deterministically after the correlated Pi run settles.
```

```ts
export function planningArtifactContract(stage: PlanningStage, paths: ArtifactPaths): PlanningArtifactContract {
  if (stage === "specify") return { paths, required: ["spec"], mustChange: ["spec"], validateGraph: false };
  if (stage === "plan") return { paths, required: ["spec", "plan"], mustChange: ["plan"], validateGraph: false };
  return { paths, required: ["spec", "plan", "tasks"], mustChange: ["tasks"], deriveGraph: true, validateGraph: true };
}

export async function validatePlanningArtifacts(root: string, contract: PlanningArtifactContract, before: ArtifactBaseline): Promise<AcceptedStageArtifacts> {
  const initial = await readRequiredFiles(root, contract.paths, contract.required);
  const taskRecords = contract.deriveGraph ? parseSpecKitTasks(initial.tasks.text) : undefined;
  if (taskRecords) await sealTaskGraph({ root, paths: contract.paths, taskRecords, tasksText: initial.tasks.text, specText: initial.spec.text });
  const loaded = await readRequiredFiles(root, contract.paths, contract.deriveGraph ? [...contract.required, "graph"] : contract.required);
  const hashes = hashArtifacts(loaded);
  for (const name of contract.mustChange) {
    if (before.hashes[loaded[name].path] === hashes[loaded[name].path]) throw new PlanningArtifactError(`${name} did not change in the correlated turn`);
  }
  const graph = contract.validateGraph ? validateTaskGraph(JSON.parse(loaded.graph.text)) : undefined;
  if (graph && taskRecords) validateGraph(graph, graphContext(taskRecords, initial.spec.text, semanticHash(taskRecords)));
  return deepFreeze({ files: loaded, hashes, graph });
}
```

`parseSpecKitTasks` accepts only phase headings matching
`^## Phase [0-9]+: (.+)$`. A task line starts with `- [ ]`, `- [x]`, or
`- [X]`, followed by a
`T[0-9]{3,}` ID, optional `[P]`, zero or more labels, a non-empty description,
and the exact separators ` | deps=`, ` | ac=`, and ` | paths=`. Each suffix is a
JSON string array. The nearest preceding phase heading supplies `phase`; a task
before one is invalid. A literal description pipe must be escaped as `\|`.

The sole metadata envelope is the exact EOF sequence
`<!-- harness-task-metadata:v1\n<json>\n-->`; its root is the closed object
`{ schema: "harness/task-metadata/v1", tasks: CanonicalTaskRecord[] }`. Parse the
line once, then require its original bytes to equal `canonicalJson(parsed)`;
this rejects duplicate keys, noncanonical key order, and whitespace ambiguity.
Records contain exactly `id`, `phase`, `labels`,
`parallelEligible`, `description`, `dependsOn`, `acceptanceRefs`, and
`ownedPaths`, in visible task order. Normalize CRLF to LF and strings to Unicode
NFC; trim only phase/description edges; unescape `\|`; reject duplicates and
then sort the set-valued arrays `labels`, `dependsOn`, `acceptanceRefs`, and `ownedPaths`;
normalize paths to repository-relative POSIX form and reject absolute paths,
`..`, empty values, or duplicate set members. Checkbox case/state is the only
discarded visible information. The canonical visible records are the source of
truth; the normalized metadata records must match them exactly, with no missing,
extra, reordered, or duplicate task.

`sealTaskGraph` writes `schema: harness/task-graph/v1`, copies the canonical
records, computes `sha256(canonicalJson(taskRecords))` itself, validates
each acceptance reference against the unique `FR-NNN:` and `SC-NNN:` bullet
tokens matching `^\s*[-*]\s+((?:FR|SC)-[0-9]{3}):` in `spec.md` (empty is
allowed for purely infrastructural tasks), and atomically renames the generated
graph. The metadata block itself is excluded from the semantic hash. The
planning model never computes a cryptographic hash.

- [ ] **Step 4: Add immediate real Spec Kit compatibility test**

When `HARNESS_COMPAT_SPECKIT=1`, resolve the repository-local preset directory
with `resolve("presets/harness-task-graph")`, pass that absolute value to
`specify preset add --dev`, resolve `speckit.tasks`, and assert the wrapped core
content and metadata instruction are both present. This job is non-subscription
and must run in the compatibility CI lane introduced in Task 34.

```ts
it.runIf(process.env.HARNESS_COMPAT_SPECKIT === "1")("resolves through the installed Spec Kit CLI", async () => {
  const project = await createDisposableSpecKitProject({ integration: "claude", aiSkills: false });
  await run("specify", ["preset", "add", "--dev", resolve("presets/harness-task-graph")], { cwd: project });
  const resolved = await run("specify", ["preset", "resolve", "speckit.tasks"], { cwd: project });
  expect(resolved.stdout).toContain("harness-task-graph");
  const materialized = await readFile(join(project, ".claude/commands/speckit.tasks.md"), "utf8");
  expect(materialized).toContain("harness-task-metadata:v1");
  expect(materialized).toContain("controller derives both deterministically");
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

it("recovers a settled planning turn when Pi crashed before the harness completion entry", async () => {
  const fixture = await planningFixture();
  const receipt = await fixture.action.execute(fixture.request());
  await fixture.pi.writeTerminalCorrelatedTranscript(receipt, changedArtifactSet());
  await fixture.restart();
  await expect(fixture.action.observe(receipt)).resolves.toMatchObject({ status: "completed" });
  expect(fixture.pi.entries("harness:planning-recovered")).toHaveLength(1);
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
  const settlement = await this.pi.reconcilePlanningSettlement(receipt);
  if (settlement.status === "active") return { status: "pending" };
  if (settlement.status === "ambiguous") return { status: "blocked", reason: "planning transcript has no safe terminal boundary", evidence: settlement.evidence };
  const pending = await this.pendingPlanning.get(receipt.correlationId);
  if (!pending) return { status: "blocked", reason: "missing durable planning request", evidence: [receipt.correlationId] };
  try {
    const stageArtifacts = await validatePlanningArtifacts(this.root, planningArtifactContract(pending.stage, pending.artifactPaths), pending.baseline);
    const artifacts = pending.stage === "tasks"
      ? await this.worktrees.sealPlanningArtifacts(this.planningWorktree, stageArtifacts.hashes)
      : stageArtifacts;
    return { status: "completed", correlationId: receipt.correlationId, artifacts };
  } catch (error) {
    return { status: "blocked", reason: toMessage(error), evidence: [receipt.sessionFile, receipt.requestEntryId, String(settlement.finalTurnIndex)] };
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
`turn_end` events update the last completed index, and `agent_settled` normally
appends `harness:planning-complete` with that final index. On restart,
`reconcilePlanningSettlement` scans the active branch entries after
`requestEntryId`. A correlated user message followed by a terminal assistant
message with an accepted stop reason, complete tool results, no later user
message, and an idle Pi session is sufficient native evidence; the extension
then appends exactly one `harness:planning-recovered` entry before validation.
Aborted, errored, active, forked, or incomplete transcripts are never accepted.
An explicit retry creates a new correlation generation and restores only the
declared harness-owned planning paths to their captured baseline in a new
planning worktree. Add fault tests for crashes before the native terminal
entry, after that entry, and after the recovered marker append.

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
- Create: `src/defaults/workflow.yaml`, `environment.yaml`, `policy.yaml`, `harness.lock`, `pi-settings.json`
- Create: `src/defaults/workflows/spec-kit-codex.yaml`, `spec-kit-devin.yaml`, `mixed-workers.yaml`
- Create: `src/cli/init.ts`, `command-detection.ts`, `config-merge.ts`, `ignore-merge.ts`, `package-root.ts`
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
    "specify", "plan", "approve_plan", "tasks", "implement", "review", "verify", "integrate",
    "post_integrate_verify", "record_task_done", "final_verify", "final_review", "push", "final_pr",
  ]);
  expect(workflow.stages.find((stage: { id: string }) => stage.id === "implement").runner.prefer).toEqual(["devin", "codex", "claude"]);
  expect(workflow.stages.find((stage: { id: string }) => stage.id === "review").runner.prefer).toEqual(["codex", "claude", "devin"]);
  const environment = await loadYaml(join(repo, ".harness/environment.yaml"));
  expect(environment.pi_packages).toEqual([
    {
      id: "harness",
      dependency: "pi-multi-agent-harness",
      scope: "project",
      resources: { extensions: ["dist/pi/extension.js"] },
    },
  ]);
  const settings = await loadJson(join(repo, ".pi/settings.json"));
  expect(settings.packages).toContainEqual(expect.objectContaining({
    source: "npm:pi-multi-agent-harness@0.1.0",
    extensions: ["+dist/pi/extension.js"],
    skills: [],
    prompts: [],
    themes: [],
  }));
  expect(await gitCheckIgnored(repo, ".pi/npm/example/package.json")).toBe(true);
  expect(await gitCheckIgnored(repo, ".pi/git/example/repo/package.json")).toBe(true);
  expect(await gitCheckIgnored(repo, ".harness-output/result.json")).toBe(true);
  expect(await gitCheckIgnored(repo, ".pi/settings.json")).toBe(false);
});

it("refuses to overwrite customized config", async () => {
  const repo = await initializedProject({ workflowName: "custom" });
  await expect(runHarness(["init", repo])).rejects.toThrow(/already exists/);
});
```

The generated environment also contains an immediately usable, project-local
Pi package declaration. Package identity and required resource paths are
project-owned data; the executable source is resolved only through the lock:

```yaml
pi_packages:
  - id: harness
    dependency: pi-multi-agent-harness
    scope: project
    resources:
      extensions: [dist/pi/extension.js]
```

Each `dependency` must name exactly one `kind: pi-package` lock entry containing
an exact Pi source string, version/ref, and integrity evidence. Resource types
are limited to `extensions`, `skills`, `prompts`, and `themes`; paths are
normalized package-relative paths with no glob or traversal, and later probes
reject symlink escape.
`init` renders the matching `.pi/settings.json` package object using exact
`+path` filters. It always writes all four resource keys and uses `[]` for an
undeclared type, so omission cannot accidentally load every resource of that
type.
Package source, filters, and scope must agree across environment, lock, and Pi
settings or configuration validation fails. Additional project packages use
the same schema, so projects can declare missing Pi plugins without changing
the harness. `init` also merges a bounded managed block into `.gitignore` for
`.pi/npm/`, `.pi/git/`, and `.harness-output/`; it preserves all existing lines,
never ignores `.pi/settings.json`, and makes a second init a no-op for that
block.

- [ ] **Step 2: Run and observe missing init command/defaults**

Run: `npm test -- test/integration/init.test.ts`

Expected: FAIL.

- [ ] **Step 3: Create the actual default workflow**

```yaml
schema: harness/v1
name: spec-kit-multi-agent
task_model:
  source: stages.tasks.outputs.graph
  complete_when: { stage: record_task_done }
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
    on_failure: { verification_failed: { retry_stage: implement } }
  - id: integrate
    uses: git.integrate
    needs: [{ stage: verify, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
  - id: post_integrate_verify
    uses: command.run
    needs: [{ stage: integrate, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    with: { argv: "${commands.task_verify}" }
    on_failure: { verification_failed: { retry_stage: implement } }
  - id: record_task_done
    uses: git.project-task-status
    needs: [{ stage: post_integrate_verify, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
  - id: final_verify
    uses: command.run
    needs: [{ stage: record_task_done, scope: all }]
    with: { argv: "${commands.full_verify}" }
  - id: final_review
    uses: worker.review
    runner: { prefer: [codex, claude, devin] }
    needs: [{ stage: final_verify, scope: all }]
    policies: { scope: final_diff }
    on_failure: { changes_requested: { block: final_review_remediation_required } }
  - id: push
    uses: git.push
    needs: [{ stage: final_review, scope: all }]
  - id: final_pr
    uses: github.pull-request
    needs: [{ stage: push, scope: all }]
```

`post_integrate_verify` runs in a detached read-only worktree pinned to the
exact candidate commit while the run branch remains unchanged.
`record_task_done` is a fenced, reconciliation-safe compare-and-swap run-branch
mutation; it promotes the verified candidate tree together with the normalized
checkbox change, then its observation atomically projects the task to `DONE`.
`final_review` reviews the complete base-to-run-branch diff and blocks rather
than silently creating an unplanned remediation task. `environment.yaml`
stores commands as argv arrays. `policy.yaml` protects planning/config paths
and excludes production credentials. The lock pins
`pi-multi-agent-harness`, Pi, TypeBox, Spec Kit, Superpowers, Herdr,
integrations, and worker CLIs to exact source identities.

- [ ] **Step 4: Implement declarative detection and atomic generation**

```ts
export async function initProject(options: InitOptions): Promise<void> {
  const commands = options.commands ?? await detectCommandsFromManifests(options.root);
  if (!commands.taskVerify || !commands.fullVerify) throw new InitError("pass --task-verify and --full-verify as JSON argv arrays");
  const root = await findPackageRoot(import.meta.url, "pi-multi-agent-harness");
  const files = await renderDefaults(root, commands);
  await assertNoExistingTargets(options.root, Object.keys(files));
  await validateGeneratedConfiguration(files);
  const ignore = await mergeHarnessIgnoreBlock(options.root);
  await atomicWriteSet(options.root, { ...files, ".gitignore": ignore });
}
```

Read manifests only; never run npm scripts. Ambiguous/empty detection prompts interactively or fails noninteractively with exact flags. Resolve assets from `import.meta.url` and package metadata, never cwd. Validate the environment/lock/settings package projection before the atomic write set; never discover or load a Pi resource during `init`.

- [ ] **Step 5: Commit after running init tests**

Run: `npm test -- test/integration/init.test.ts && npm run typecheck`

Expected: PASS for Node, Python, ambiguity, spaces, existing config, preserved custom `.gitignore`, repeated managed-block merge, project cache/output ignores, trackable Pi settings, non-Git path, and packaged asset lookup.

```bash
git add src/defaults src/cli test/integration/init.test.ts test/fixtures/projects
git commit -m "feat: initialize runnable harness workflows"
```

## Task 28: Run Resident Scheduling and Semantic Commands in Pi

**Files:**
- Create: `src/pi/controller-registry.ts`, `events.ts`, `commands.ts`, `status-view.ts`, `planning-profile.ts`
- Modify: `src/pi/extension.ts`, `planning-agent.ts`
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

it("keeps the planning profile selected through the correlated agent settlement", async () => {
  const fixture = await piResidencyFixture({ currentModel: "interactive-model", thinkingLevel: "medium" });
  const receipt = await fixture.startPlanning("tasks");
  expect(fixture.pi.currentModelId()).toBe("chatgpt-planning-model");
  expect(fixture.pi.currentThinkingLevel()).toBe("high");
  await fixture.pi.emitCorrelatedTurnEnd(receipt);
  expect(fixture.pi.currentModelId()).toBe("chatgpt-planning-model");
  expect(fixture.pi.providerRequestModels(receipt)).toEqual(["chatgpt-planning-model"]);
  await fixture.pi.emitCorrelatedAgentSettled(receipt);
  await fixture.queue.drain();
  expect(fixture.pi.currentModelId()).toBe("interactive-model");
  expect(fixture.pi.currentThinkingLevel()).toBe("medium");
});

it("restores an unfinished profile lease from terminal transcript evidence", async () => {
  const fixture = await piResidencyFixture({ crashAfter: "planning-native-terminal" });
  const receipt = await fixture.startPlanning("plan");
  await fixture.crashAndRestart();
  await fixture.recoverPlanning(receipt);
  expect(fixture.pi.entries("harness:planning-profile-restored")).toHaveLength(1);
  expect(fixture.pi.currentModelId()).toBe(fixture.previousModelId);
});

it("blocks a planning generation if the selected model drifts", async () => {
  const fixture = await piResidencyFixture();
  const receipt = await fixture.startPlanning("tasks");
  await fixture.pi.emitModelSelect("unexpected-model");
  await fixture.pi.emitCorrelatedAgentSettled(receipt);
  await expect(fixture.observePlanning(receipt)).resolves.toMatchObject({
    status: "blocked", reason: expect.stringMatching(/planning model drift/),
  });
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
normally appends a durable completion entry at `agent_settled`. Recovery may
append one `harness:planning-recovered` entry only from the terminal native
transcript proof defined in Task 25; intermediate, ambiguous, or arbitrary turns
cannot advance planning. Status commands read snapshots without model calls.
Mutating commands append operator intents.

- [ ] **Step 4: Enforce planning profile and run approval boundaries**

Resolve `chatgpt-planning` from machine-local Pi settings, verify authenticated
ChatGPT subscription capability, and hold a correlation-bound profile lease
until the exact planning run settles. `/harness-run` displays workflow hash,
commands, workers, credential profiles, permissions, branches, push, and PR
effects before approval. Do not serialize credentials.

```ts
export interface ModelIdentity { provider: string; modelId: string }
export interface PlanningProfileLease {
  correlationId: string;
  previous: { model: ModelIdentity; thinkingLevel: ThinkingLevel };
  planning: { model: ModelIdentity; thinkingLevel: ThinkingLevel };
  entryId: string;
}
export interface PlanningSettlement {
  correlationId: string;
  terminal: true;
  finalTurnIndex: number;
}
export interface PiModelPort {
  currentModel(): Promise<PiModel>;
  currentThinkingLevel(): Promise<ThinkingLevel>;
  resolveAuthenticatedProfile(name: string): Promise<{ model: PiModel; thinkingLevel: ThinkingLevel } | undefined>;
  resolveModelIdentity(identity: ModelIdentity): Promise<PiModel | undefined>;
  selectModel(model: PiModel): Promise<void>;
  selectThinkingLevel(level: ThinkingLevel): Promise<void>;
  appendEntry(customType: string, data: unknown): void;
  getLeafId(): string | undefined;
}
export interface PlanningProfileStore {
  activeLease(): Promise<PlanningProfileLease | undefined>;
  isRestored(selectedEntryId: string): Promise<boolean>;
}

export class PlanningProfileCoordinator {
  constructor(private readonly pi: PiModelPort, private readonly store: PlanningProfileStore) {}

  async begin(correlationId: string): Promise<PlanningProfileLease> {
    if (await this.store.activeLease()) throw new PolicyBlocker("PLANNING_PROFILE_ALREADY_LEASED");
    const previous = {
      model: modelIdentity(await this.pi.currentModel()),
      thinkingLevel: await this.pi.currentThinkingLevel(),
    };
    const planning = await this.pi.resolveAuthenticatedProfile("chatgpt-planning");
    if (!planning || planning.model.provider !== "openai-codex") {
      throw new PolicyBlocker("CHATGPT_PLANNING_PROFILE_UNAVAILABLE");
    }
    const lease = { correlationId, previous, planning: {
      model: modelIdentity(planning.model), thinkingLevel: planning.thinkingLevel,
    } };
    this.pi.appendEntry("harness:planning-profile-selected", lease);
    const entryId = this.pi.getLeafId();
    if (!entryId) throw new PlanningCorrelationError("profile selection entry was not persisted");
    await this.pi.selectModel(planning.model);
    await this.pi.selectThinkingLevel(planning.thinkingLevel);
    return deepFreeze({ ...lease, entryId });
  }

  async restoreAfterSettlement(lease: PlanningProfileLease, settlement: PlanningSettlement): Promise<void> {
    if (settlement.correlationId !== lease.correlationId || !settlement.terminal) {
      throw new PlanningCorrelationError("profile restore requires exact terminal settlement");
    }
    if (await this.store.isRestored(lease.entryId)) return;
    const previousModel = await this.pi.resolveModelIdentity(lease.previous.model);
    if (!previousModel) throw new PolicyBlocker("PREVIOUS_INTERACTIVE_MODEL_UNAVAILABLE");
    await this.pi.selectModel(previousModel);
    await this.pi.selectThinkingLevel(lease.previous.thinkingLevel);
    this.pi.appendEntry("harness:planning-profile-restored", {
      correlationId: lease.correlationId,
      selectedEntryId: lease.entryId,
    });
  }
}
```

`PlanningAgent.enqueue` calls `begin` before `sendUserMessage`; recovery finds
the lease by the receipt correlation ID. A returned send call or `turn_end`
never releases the lease. The correlated `agent_settled` handler durably records settlement,
then calls `restoreAfterSettlement`; recovery may do the same only after Task
25's terminal-transcript proof. If a crash occurred after profile selection but
before a correlated user entry existed, recovery restores the previous model and
invalidates that generation. Pi's `model_select` and `thinking_level_select`
events are observational rather than cancellable, so any event that moves away
from the leased model/thinking pair before settlement records
`harness:planning-profile-drift`, aborts/blocks that generation, and requires an
explicit retry; drifted artifacts are never accepted. Only provider/model
identities and thinking levels are stored; auth material remains machine-local.

Run: `npm run check:phase4`

Expected: PASS, including real loader compatibility tests; no test starts a model turn unless explicitly gated.

- [ ] **Step 5: Commit and stop for milestone review**

```bash
git add src/pi src/cli/main.ts test/integration/pi-residency.test.ts test/unit/pi-commands.test.ts package.json package-lock.json
git commit -m "feat: host resident orchestration in Pi"
```
