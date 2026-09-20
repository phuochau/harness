# Pi Multi-Agent Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a local-first Pi package and `harness` CLI that turns Spec Kit plans into durable, policy-governed, multi-agent runs across Devin, Codex, and Claude through Herdr.

**Architecture:** One TypeScript package contains a deterministic workflow core, an event-sourced resident controller, a Herdr-only runtime, worker adapters, Git/Spec Kit/GitHub actions, a Pi extension, and a trusted bootstrap CLI. The core depends only on explicit ports and is proven first against fakes; native integrations are added behind those ports after the state, scheduling, and safety invariants pass.

**Tech Stack:** Node.js 22+, TypeScript ESM, TypeBox/JSON Schema, Ajv, YAML, Vitest, fast-check, Git CLI, GitHub CLI, Herdr CLI/socket API, Pi extension API, Spec Kit presets.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Global Constraints

- Pi is the only global orchestrator; Herdr is the required local execution plane and never decides readiness, routing, retries, or completion.
- Node.js 22 or newer is the only bootstrap prerequisite for the first release.
- Ship one publishable npm/Pi package named `@pi-harness/cli`, with the `harness` executable and Pi extension in the same artifact.
- Codex, Devin, and Claude are first-class worker kinds; default implementation order is Devin, Codex, Claude, while default review order is Codex, Claude, Devin.
- A reviewer must be a different worker kind from the implementation worker; absence of an eligible reviewer blocks the job.
- Superpowers is worker-only. The allowlist excludes planning, delegation, parallel-agent dispatch, worktree management, and branch-finishing skills.
- Workers may read but never modify `spec.md`, `plan.md`, `tasks.md`, `task-graph.json`, `.harness/`, or `.pi/`.
- Runtime state is stored beneath `<git-common-dir>/harness/runs`; only the resident controller writes it.
- Every external effect uses durable intent/observation events and a stable idempotency key.
- An active run's compiled workflow is immutable. Changed workflow content creates a new run revision.
- Bootstrap executes no repository code before approval and installs only locked sources allowed by the machine policy.
- Final pull-request creation requires GitHub CLI, an authenticated GitHub remote, full verification, and a final diff review.
- Keep scope local-only: no Tailscale, remote control, Pi Web, multi-machine Herdr, dashboard, or Devin API transport.

## Review Focus

- Crash after recording an external-action intent but before recording its result: Task 9 must prove reconciliation finds the existing effect and does not launch it twice.
- Two controller processes contend for one run or a stale process resumes after takeover: Task 5 must prove the stale fencing token cannot append.
- A dynamic task collection contains duplicate keys or mixes `same-item` joins with an `all` barrier: Task 4 must reject duplicates and materialize only the correct jobs.
- Codex implements after Devin is unavailable, while Codex is still first in review preference: Task 7 must skip Codex for review, select Claude, and block if no distinct reviewer exists.
- A cloned repository supplies malicious lifecycle scripts or a command disguised as declarative config: Task 17 must prove dry-run and pre-approval bootstrap never execute it.

---

## File Map

The repository starts with documentation only. Create one focused package with these ownership boundaries:

```text
package.json                         package metadata, scripts, Pi manifest, CLI bin
package-lock.json                    exact npm dependency graph
tsconfig.json                        strict editor/test compilation
tsconfig.build.json                  distributable ESM build
vitest.config.ts                     unit, integration, and gated-test configuration
.gitignore                           build, coverage, and local runtime output
.github/workflows/ci.yml             Node 22 verification and package smoke test

src/contracts/                       TypeBox schemas and exported domain types only
src/config/                          YAML loading, interpolation, compilation, hashing
src/core/                            reducer, graph materialization, routing, scheduler
src/state/                           Git-common paths, lease, JSONL journal, snapshots
src/ports/                           runtime, process, clock, and approval interfaces
src/controller/                      resident event loop and action reconciliation
src/actions/                         command, human approval, Git, Spec Kit, GitHub actions
src/git/                             repository inspection, branches, worktrees, integration
src/runtime/herdr/                   socket client and Herdr AgentRuntime
src/runtime/workers/                 Codex, Devin, and Claude adapters
src/speckit/                         preset installer and task artifact validation
src/install/                         probes, trust policy, recipes, plan, receipts
src/cli/                             init/bootstrap/doctor/start/status/recover commands
src/pi/                              Pi extension registration and semantic slash commands
src/defaults/                        immediately usable workflow/environment/policy templates

presets/harness-task-graph/          versioned Spec Kit wrap preset
bin/harness.mjs                      published CLI launcher

test/unit/                           pure schema, compiler, reducer, scheduler, policy tests
test/integration/                    filesystem, Git, Herdr protocol, installer tests
test/contract/                       shared worker adapter contract suite
test/e2e/                            fake end-to-end and opt-in real smoke tests
test/fixtures/                       valid and invalid workflows, graphs, results, event logs
```

## Milestone 1: Deterministic Core

### Task 1: Scaffold the publishable Pi package

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts`
- Create: `bin/harness.mjs`
- Test: `test/unit/package-layout.test.ts`

**Interfaces:**
- Consumes: Node.js 22 and npm.
- Produces: package exports `@pi-harness/cli`, `@pi-harness/cli/core`, and `@pi-harness/cli/extension`; executable `harness`; npm scripts `build`, `typecheck`, `test`, and `check`.

- [ ] **Step 1: Write the package-layout test**

```ts
// test/unit/package-layout.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("published package", () => {
  it("declares one CLI and one Pi extension", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.name).toBe("@pi-harness/cli");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.bin).toEqual({ harness: "./bin/harness.mjs" });
    expect(pkg.pi.extensions).toEqual(["./dist/pi/extension.js"]);
    expect(pkg.exports["."]).toBe("./dist/index.js");
    expect(pkg.exports["./core"]).toBe("./dist/index.js");
    expect(pkg.exports["./extension"]).toBe("./dist/pi/extension.js");
    expect(pkg.files).toEqual(["dist", "bin", "presets", "src/defaults"]);
  });
});
```

- [ ] **Step 2: Run the test and verify the empty repository fails**

Run: `npm test -- test/unit/package-layout.test.ts`

Expected: FAIL because `package.json` and the test runner do not exist.

- [ ] **Step 3: Create the package and compiler configuration**

Create `package.json` with `type: "module"`, version `0.1.0`, the exports asserted above, and these scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "npm run typecheck && npm test && npm run build"
  }
}
```

Install runtime and test dependencies with exact npm versions and generate `package-lock.json`:

```bash
npm install --save-exact ajv commander minimatch proper-lockfile yaml
npm install --save-dev --save-exact @earendil-works/pi-coding-agent @types/node @types/proper-lockfile fast-check typebox typescript vitest
```

Declare `@earendil-works/pi-coding-agent` and `typebox` as peer dependencies with `"*"` ranges, keep both in dev dependencies for standalone tests, add `keywords: ["pi-package"]`, and compile `src/**/*.ts` into `dist/` with strict TypeScript settings.

- [ ] **Step 4: Add minimal package entrypoints**

```ts
// src/index.ts
export const HARNESS_VERSION = "0.1.0";
```

```js
#!/usr/bin/env node
// bin/harness.mjs
await import("../dist/cli/main.js");
```

Add build output, coverage, `.harness-output/`, and `node_modules/` to `.gitignore`.

- [ ] **Step 5: Run the package checks**

Run: `npm run check`

Expected: PASS; TypeScript builds `dist/index.js`, and the package-layout test passes.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .gitignore src/index.ts bin/harness.mjs test/unit/package-layout.test.ts
git commit -m "chore: scaffold Pi harness package"
```

### Task 2: Define versioned external contracts

**Files:**
- Create: `src/contracts/workflow.ts`
- Create: `src/contracts/environment.ts`
- Create: `src/contracts/policy.ts`
- Create: `src/contracts/task-graph.ts`
- Create: `src/contracts/worker-result.ts`
- Create: `src/contracts/events.ts`
- Create: `src/contracts/index.ts`
- Create: `src/contracts/validate.ts`
- Test: `test/unit/contracts.test.ts`
- Test fixture: `test/fixtures/contracts/valid-worker-result.json`

**Interfaces:**
- Consumes: TypeBox schemas and Ajv.
- Produces: `validateOrThrow<T>(schema, value, source): T`; types `WorkflowDefinition`, `EnvironmentConfig`, `SecurityPolicy`, `TaskGraph`, `WorkerResult`, and `RunEvent`.

- [ ] **Step 1: Write failing schema tests**

```ts
// test/unit/contracts.test.ts
import { describe, expect, it } from "vitest";
import { TaskGraphSchema, WorkerResultSchema, WorkflowSchema, validateOrThrow } from "../../src/contracts/index.js";

describe("versioned contracts", () => {
  it("rejects an unknown workflow field", () => {
    expect(() => validateOrThrow(WorkflowSchema, {
      schema: "harness/v1", name: "x", stages: [], surprise: true,
    }, "workflow.yaml")).toThrow(/workflow.yaml.*surprise/);
  });

  it("requires worker results to bind a job and attempt", () => {
    expect(() => validateOrThrow(WorkerResultSchema, {
      schema: "harness/worker-result/v1", outcome: "completed",
    }, "result.json")).toThrow(/jobId|attempt/);
  });

  it("accepts explicit task dependencies", () => {
    const graph = validateOrThrow(TaskGraphSchema, {
      schema: "harness/task-graph/v1",
      tasksSemanticHash: "sha256:abc",
      tasks: [{ id: "T001", dependsOn: [], parallel: true, files: ["src/a.ts"], acceptance: ["AC-1"] }],
    }, "task-graph.json");
    expect(graph.tasks[0].id).toBe("T001");
  });
});
```

- [ ] **Step 2: Run the contract tests and verify failure**

Run: `npm test -- test/unit/contracts.test.ts`

Expected: FAIL because the contract modules do not exist.

- [ ] **Step 3: Implement closed TypeBox schemas**

Use `additionalProperties: false` on every externally supplied object. Define these exact discriminants and enums:

```ts
export type WorkerKind = "pi" | "codex" | "devin" | "claude";
export type JobState = "PENDING" | "READY" | "RUNNING" | "VERIFYING" | "DONE" | "RETRY" | "BLOCKED" | "FAILED";
export type WorkerOutcome = "completed" | "blocked" | "failed";
export type ReviewVerdict = "approved" | "changes_requested" | "blocked";
export type DependencyScope = "all" | "same-item";
export type InstallerKind = "npm" | "package-manager" | "signed-release" | "manual";
```

`WorkflowSchema` must cover `task_model`, `stages`, `needs`, `if`, `foreach`, `runner`, `model_profile`, `with`, `policies`, `produces`, `retry`, `timeout`, and `on_failure`. `EnvironmentSchema` must cover typed named commands as `argv: string[]`, logical model profiles, tool probes, and installer recipes. `PolicySchema` must cover allowed sources, permission ceilings, protected paths, isolation requirements, and review separation. `WorkerResultSchema` must be a discriminated union for execute and review results; review results bind `implementationAttemptId` and `commitTree`, while blocked results require `reason`, evidence paths, and `suggestedChange`. `RunEventSchema` must require the sequence, fencing token, idempotency key, previous hash, and event hash fields used by Task 5.

- [ ] **Step 4: Implement one Ajv validation boundary**

```ts
// src/contracts/validate.ts
import Ajv, { type ErrorObject } from "ajv";
import type { TSchema, Static } from "typebox";

const ajv = new Ajv({ allErrors: true, strict: true });

export function validateOrThrow<S extends TSchema>(schema: S, value: unknown, source: string): Static<S> {
  const validate = ajv.compile(schema);
  if (validate(value)) return value as Static<S>;
  const details = (validate.errors ?? []).map((error: ErrorObject) =>
    `${error.instancePath || "/"} ${error.message} ${JSON.stringify(error.params)}`,
  ).join("; ");
  throw new Error(`${source}: ${details}`);
}
```

Export every schema and static type from `src/contracts/index.ts`.

- [ ] **Step 5: Run schema and type checks**

Run: `npm test -- test/unit/contracts.test.ts && npm run typecheck`

Expected: PASS with all three contract cases green.

- [ ] **Step 6: Commit**

```bash
git add src/contracts test/unit/contracts.test.ts test/fixtures/contracts
git commit -m "feat: define harness contracts"
```

### Task 3: Compile and freeze workflow configuration

**Files:**
- Create: `src/config/load-yaml.ts`
- Create: `src/config/hash.ts`
- Create: `src/config/expressions.ts`
- Create: `src/config/predicates.ts`
- Create: `src/config/compiler.ts`
- Create: `src/config/types.ts`
- Test: `test/unit/workflow-compiler.test.ts`
- Create: `test/support/fixture-config.ts`
- Test fixtures: `test/fixtures/workflows/valid.yaml`
- Test fixtures: `test/fixtures/workflows/cycle.yaml`

**Interfaces:**
- Consumes: `WorkflowDefinition`, `EnvironmentConfig`, and `SecurityPolicy` from Task 2.
- Produces: `compileWorkflow(input: CompileInput): CompiledWorkflow`; `hashCanonical(value): string`; `loadYamlFile(path, schema)`.

- [ ] **Step 1: Write failing compiler tests**

```ts
// test/unit/workflow-compiler.test.ts
import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../../src/config/compiler.js";
import { fixtureConfig } from "../support/fixture-config.js";

describe("compileWorkflow", () => {
  it("resolves a typed command and freezes a stable hash", () => {
    const input = fixtureConfig({ command: "${commands.task_verify}" });
    const first = compileWorkflow(input);
    const second = compileWorkflow(input);
    expect(first.stages.find((stage) => stage.id === "verify")?.with.command)
      .toEqual({ argv: ["npm", "test"] });
    expect(first.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("rejects cycles and unresolved expressions", () => {
    expect(() => compileWorkflow(fixtureConfig({ cycle: true }))).toThrow(/cycle.*implement.*review/i);
    expect(() => compileWorkflow(fixtureConfig({ command: "${commands.missing}" }))).toThrow(/commands\.missing/);
  });
});
```

- [ ] **Step 2: Run the compiler tests and verify failure**

Run: `npm test -- test/unit/workflow-compiler.test.ts`

Expected: FAIL because `compileWorkflow` and fixture support do not exist.

- [ ] **Step 3: Implement deterministic loading, interpolation, and hashing**

```ts
// src/config/types.ts
export interface CompileInput {
  workflow: WorkflowDefinition;
  environment: EnvironmentConfig;
  projectPolicy: SecurityPolicy;
  machinePolicy: SecurityPolicy;
}

export interface CompiledWorkflow extends WorkflowDefinition {
  contentHash: `sha256:${string}`;
  effectivePolicy: SecurityPolicy;
}
```

Implement `${commands.NAME}` only when the entire scalar is the expression, resolving to the typed command object instead of shell text. Canonically sort object keys before SHA-256 hashing. Topologically sort stage IDs and report the full cycle path. Intersect permissions as deny-wins, minimum resource limits, maximum path restrictions, and the stronger isolation/review requirements.

Represent `if` as a closed declarative predicate AST with `all`, `any`, `not`, `exists`, and `eq` nodes over `inputs.*` and `stages.<id>.outputs.*` references. Validate references at compile time when static and evaluate without `eval`, template code, property prototypes, or shell expansion.

- [ ] **Step 4: Add mutation and unknown-reference coverage**

Extend the test to mutate the input after compilation and assert the compiled value does not change. Add cases for duplicate stage IDs, missing `needs.stage`, a `same-item` dependency without compatible `foreach`, a remediation target that is not an ancestor, retry policies without finite attempt and elapsed-time budgets, an output path escaping the repository, and a predicate attempting to access `__proto__`.

- [ ] **Step 5: Run compiler tests**

Run: `npm test -- test/unit/workflow-compiler.test.ts && npm run typecheck`

Expected: PASS; identical semantic inputs have identical hashes and every invalid reference fails before execution.

- [ ] **Step 6: Commit**

```bash
git add src/config test/unit/workflow-compiler.test.ts test/fixtures/workflows test/support/fixture-config.ts
git commit -m "feat: compile immutable workflows"
```

### Task 4: Validate Spec Kit task graphs and materialize fan-out jobs

**Files:**
- Create: `src/core/task-graph.ts`
- Create: `src/core/materialize.ts`
- Create: `src/core/job-id.ts`
- Test: `test/unit/task-graph.test.ts`
- Test: `test/unit/materialize.test.ts`
- Test fixtures: `test/fixtures/task-graphs/diamond.json`

**Interfaces:**
- Consumes: `TaskGraph`, `CompiledWorkflow`.
- Produces: `validateTaskGraph(graph, tasksMarkdown): ValidatedTaskGraph`; `materializeStage(workflow, stageId, outputs): readonly JobDefinition[]`; `jobId(stageId, itemKey): string`.

- [ ] **Step 1: Write failing graph-validation tests**

```ts
it("rejects a graph whose semantic task hash is stale", () => {
  expect(() => validateTaskGraph(graph, "- [ ] T001 changed description"))
    .toThrow(/semantic hash/i);
});

it("allows overlapping files only when dependencies order the tasks", () => {
  const unordered = graphWithTasks([
    task("T001", [], ["src/shared.ts"]),
    task("T002", [], ["src/shared.ts"]),
  ]);
  expect(() => validateTaskGraph(unordered, markdownFor(unordered))).toThrow(/file ownership.*src\/shared\.ts/i);
  const ordered = graphWithTasks([
    task("T001", [], ["src/shared.ts"]),
    task("T002", ["T001"], ["src/shared.ts"]),
  ]);
  expect(validateTaskGraph(ordered, markdownFor(ordered)).tasks).toHaveLength(2);
});
```

- [ ] **Step 2: Run graph tests and verify failure**

Run: `npm test -- test/unit/task-graph.test.ts`

Expected: FAIL because graph validation is absent.

- [ ] **Step 3: Implement graph validation**

Normalize only the checkbox marker in `tasks.md`, compute `sha256:<hex>`, and reject unknown dependencies, duplicate IDs, cycles, missing acceptance references, and unordered overlapping file scopes. Return task IDs in stable topological order with an immutable `byId` map.

- [ ] **Step 4: Write failing fan-out/fan-in tests**

```ts
it("materializes keyed jobs and preserves join semantics", () => {
  const jobs = materializeStage(compiledWorkflow, "review", {
    "stages.tasks.outputs.graph": diamondGraph,
  });
  expect(jobs.map((job) => [job.id, job.itemKey])).toEqual([
    ["review:T001", "T001"], ["review:T002", "T002"], ["review:T003", "T003"],
  ]);
  expect(jobs[0].dependencies).toEqual([{ jobId: "implement:T001", scope: "same-item" }]);
});

it("rejects duplicate and missing item keys", () => {
  expect(() => materializeStage(compiledWorkflow, "review", {
    "stages.tasks.outputs.graph": { tasks: [{ id: "T001" }, { id: "T001" }] },
  }))
    .toThrow(/duplicate item key T001/);
});

it("expands an all-scope fan-in barrier", () => {
  const jobs = materializeStage(compiledWorkflow, "final_verify", {
    "stages.tasks.outputs.graph": diamondGraph,
  });
  expect(jobs[0].dependencies.map((dependency) => dependency.jobId)).toEqual([
    "integrate:T001", "integrate:T002", "integrate:T003",
  ]);
});
```

- [ ] **Step 5: Implement materialization**

Static stages receive one job ID equal to the stage ID. Fan-out jobs use `<stageId>:<percent-encoded-itemKey>`. `same-item` dependencies bind exactly one upstream key; `all` dependencies bind every upstream job in stable key order. Materialization persists the source artifact hash so retries cannot silently use a changed collection.

- [ ] **Step 6: Run graph and materialization tests**

Run: `npm test -- test/unit/task-graph.test.ts test/unit/materialize.test.ts`

Expected: PASS, including the duplicate-key Review Focus case.

- [ ] **Step 7: Commit**

```bash
git add src/core/task-graph.ts src/core/materialize.ts src/core/job-id.ts test/unit/task-graph.test.ts test/unit/materialize.test.ts test/fixtures/task-graphs
git commit -m "feat: validate task DAGs and materialize jobs"
```

### Task 5: Persist fenced, hash-chained run state

**Files:**
- Create: `src/state/paths.ts`
- Create: `src/state/lease.ts`
- Create: `src/state/event-store.ts`
- Create: `src/state/snapshot-store.ts`
- Create: `src/state/run-repository.ts`
- Test: `test/integration/state-store.test.ts`
- Test fixtures: `test/fixtures/events/torn-tail.jsonl`
- Test fixtures: `test/fixtures/events/interior-corruption.jsonl`

**Interfaces:**
- Consumes: `RunEvent` schema; canonical repository root and `git rev-parse --git-common-dir` output.
- Produces: `RunRepository.create`, `RunRepository.acquire`, `RunLease.append`, `RunLease.saveSnapshot`, `RunLease.recover`, and `RunLease.release`.

- [ ] **Step 1: Write failing durability tests**

```ts
it("fences a stale lease owner", async () => {
  const first = await repository.acquire("F023");
  await first.release();
  const second = await repository.acquire("F023");
  await expect(first.append(event("job.ready"))).rejects.toThrow(/stale fencing token/);
  await second.release();
});

it("repairs only a torn final record", async () => {
  await copyFixture("events/torn-tail.jsonl", run.eventsPath);
  const recovered = await repository.recover("F023");
  expect(recovered.diagnostics).toContainEqual(expect.objectContaining({ kind: "truncated-tail" }));
  await copyFixture("events/interior-corruption.jsonl", run.eventsPath);
  await expect(repository.recover("F023")).rejects.toThrow(/interior corruption/);
});
```

- [ ] **Step 2: Run state tests and verify failure**

Run: `npm test -- test/integration/state-store.test.ts`

Expected: FAIL because the repository and lease types do not exist.

- [ ] **Step 3: Implement canonical paths and exclusive lease acquisition**

```ts
export interface RunPaths {
  gitCommonDir: string;
  runDir: string;
  events: string;
  snapshot: string;
  artifacts: string;
  evidence: string;
  logs: string;
}

export async function resolveRunPaths(repoRoot: string, runId: string, exec: CommandExecutor): Promise<RunPaths>;
```

Resolve and realpath both repository root and Git common directory. Create run directories with mode `0o700` and state/log/evidence files with mode `0o600`. Isolate locking behind `LeaseBackend`: tests use an in-memory backend and production uses `proper-lockfile` on the run lease file with stale-lock takeover disabled until explicit recovery validates the recorded PID and process start time. Increment and `fsync` the durable fencing token before returning ownership.

- [ ] **Step 4: Implement the event append protocol**

Serialize each event as one canonical JSON line containing `seq`, `timestamp`, IDs, `idempotencyKey`, `fencingToken`, `payload`, `prevHash`, and `eventHash`. Under the lease lock, verify the current token, append bytes, call `fsync`, and only then return. Write snapshots to `state.json.tmp`, `fsync`, rename atomically, then `fsync` the parent directory.

Every snapshot records the last applied event sequence and event hash. Recovery may use it as a replay boundary only after verifying that exact sequence/hash pair against the complete journal chain.

- [ ] **Step 5: Implement recovery and corruption rules**

Stream and verify the complete sequence/hash chain. Preserve a copy of an incomplete final line under `logs/recovery/` before truncating it. Reject malformed interior records, sequence gaps, wrong hashes, snapshot boundaries not present in the log, and event tokens newer than the durable lease record.

- [ ] **Step 6: Run durability tests repeatedly**

Run: `npm test -- test/integration/state-store.test.ts`

Expected: PASS, including stale-owner and torn-write cases.

- [ ] **Step 7: Commit**

```bash
git add src/state test/integration/state-store.test.ts test/fixtures/events
git commit -m "feat: add durable fenced run state"
```

### Task 6: Reduce events into job, attempt, stage, and task state

**Files:**
- Create: `src/core/state.ts`
- Create: `src/core/reducer.ts`
- Create: `src/core/transitions.ts`
- Create: `src/core/task-projection.ts`
- Test: `test/unit/reducer.test.ts`
- Test: `test/unit/reducer.property.test.ts`

**Interfaces:**
- Consumes: validated `RunEvent`, materialized `JobDefinition`, and `ValidatedTaskGraph`.
- Produces: `initialRunState(workflow): RunState`; `reduceEvent(state, event): RunState`; `projectTaskState(state, taskId): JobState`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it("never accepts worker completion as task DONE", () => {
  const state = replay([
    event("job.materialized", { jobId: "implement:T001", itemKey: "T001" }),
    event("attempt.started", { jobId: "implement:T001", attemptId: "A1", worker: "devin" }),
    event("attempt.result.accepted", { jobId: "implement:T001", attemptId: "A1", outcome: "completed" }),
  ]);
  expect(state.jobs["implement:T001"].state).toBe("VERIFYING");
  expect(projectTaskState(state, "T001")).toBe("VERIFYING");
});

it("marks a task DONE only after its completion-stage job", () => {
  const state = replay(successfulTaskEvents("T001", "integrate"));
  expect(projectTaskState(state, "T001")).toBe("DONE");
});

it("invalidates downstream generations after remediation", () => {
  const state = replay(reviewChangesRequestedEvents("T001"));
  expect(state.jobs["implement:T001"].state).toBe("RETRY");
  expect(state.jobs["review:T001"].validForGeneration).toBeUndefined();
});
```

- [ ] **Step 2: Run reducer tests and verify failure**

Run: `npm test -- test/unit/reducer.test.ts`

Expected: FAIL because the reducer is absent.

- [ ] **Step 3: Implement legal transitions and immutable reduction**

```ts
const LEGAL: Readonly<Record<JobState, readonly JobState[]>> = {
  PENDING: ["READY", "BLOCKED", "FAILED"],
  READY: ["RUNNING", "BLOCKED", "FAILED"],
  RUNNING: ["VERIFYING", "RETRY", "BLOCKED", "FAILED"],
  VERIFYING: ["DONE", "RETRY", "BLOCKED", "FAILED"],
  DONE: ["RETRY"],
  RETRY: ["READY", "BLOCKED", "FAILED"],
  BLOCKED: ["READY", "FAILED"],
  FAILED: [],
};
```

`DONE -> RETRY` is accepted only for a `job.invalidated` event naming a downstream remediation policy and a newer generation. Every attempt is immutable; the job stores `activeAttemptId`, `generation`, `validResult`, and attempt history. Stage state is derived from its jobs instead of being independently mutated.

- [ ] **Step 4: Add property tests for invariants**

```ts
it("has at most one active attempt per job", () => {
  fc.assert(fc.property(eventSequenceArbitrary(), (events) => {
    const state = replayValidPrefix(events);
    for (const job of Object.values(state.jobs)) {
      expect(job.attempts.filter((attempt) => attempt.state === "RUNNING")).toHaveLength(job.activeAttemptId ? 1 : 0);
    }
  }));
});

it("never projects DONE before integration", () => {
  fc.assert(fc.property(eventSequenceArbitrary(), (events) => {
    const state = replayValidPrefix(events);
    for (const taskId of Object.keys(state.tasks)) {
      if (projectTaskState(state, taskId) === "DONE") {
        expect(state.jobs[`integrate:${taskId}`].state).toBe("DONE");
      }
    }
  }));
});
```

- [ ] **Step 5: Run reducer and property tests**

Run: `npm test -- test/unit/reducer.test.ts test/unit/reducer.property.test.ts`

Expected: PASS with no illegal transition or premature `DONE` state.

- [ ] **Step 6: Commit**

```bash
git add src/core/state.ts src/core/reducer.ts src/core/transitions.ts src/core/task-projection.ts test/unit/reducer.test.ts test/unit/reducer.property.test.ts
git commit -m "feat: reduce durable workflow state"
```

### Task 7: Enforce routing, retry, and independent-review policy

**Files:**
- Create: `src/core/capabilities.ts`
- Create: `src/core/routing.ts`
- Create: `src/core/retry.ts`
- Create: `src/core/policy.ts`
- Test: `test/unit/routing.test.ts`
- Test: `test/unit/retry.test.ts`

**Interfaces:**
- Consumes: compiled runner preference, effective policy, worker probes, prior attempts, and implementation worker identity.
- Produces: `selectWorker(input): RoutingDecision`; `nextRetry(input): RetryDecision`; `assertActionAllowed(policy, request): void`.

- [ ] **Step 1: Write failing review-routing tests**

```ts
it("selects a different reviewer after implementation fallback", () => {
  const decision = selectWorker({
    purpose: "review",
    preference: ["codex", "claude", "devin"],
    implementationWorker: "codex",
    candidates: available("codex", "claude", "devin"),
    requireDifferentWorkerKind: true,
  });
  expect(decision).toEqual({ kind: "selected", worker: "claude", reason: "first eligible distinct worker" });
});

it("blocks when no independent reviewer exists", () => {
  const decision = selectWorker({
    purpose: "review",
    preference: ["codex"],
    implementationWorker: "codex",
    candidates: available("codex"),
    requireDifferentWorkerKind: true,
  });
  expect(decision).toEqual({ kind: "blocked", reason: "no distinct eligible reviewer" });
});
```

- [ ] **Step 2: Run routing tests and verify failure**

Run: `npm test -- test/unit/routing.test.ts`

Expected: FAIL because routing is absent.

- [ ] **Step 3: Implement deterministic routing and recorded explanations**

Filter candidates by declared capability, authentication, reported isolation (`native-sandbox`, `container`, or `unrestricted-host`), concurrency, permission policy, and review separation, then preserve declared preference order. Worktree isolation never satisfies a sandbox requirement. Never use model judgment. Return a complete list of rejected candidates and reasons for the routing event payload.

- [ ] **Step 4: Write and implement retry-budget tests**

```ts
it("exhausts either attempt or elapsed budget", () => {
  expect(nextRetry({ attempts: 3, elapsedMs: 10_000, maxAttempts: 3, maxElapsedMs: 60_000, category: "transient" }).kind)
    .toBe("failed");
  expect(nextRetry({ attempts: 1, elapsedMs: 60_001, maxAttempts: 3, maxElapsedMs: 60_000, category: "transient" }).kind)
    .toBe("failed");
});

it("never retries policy violations or expands permissions", () => {
  expect(nextRetry({ attempts: 1, elapsedMs: 1, maxAttempts: 3, maxElapsedMs: 60_000, category: "policy" }).kind)
    .toBe("failed");
});
```

Implement category behavior from the design: same-worker backoff for transient errors, declared fallback for unavailability, block for authentication/specification issues, remediation for verification/integration failures, and immediate failure for policy violations.

- [ ] **Step 5: Run policy tests**

Run: `npm test -- test/unit/routing.test.ts test/unit/retry.test.ts`

Expected: PASS, including both Review Focus independent-review cases.

- [ ] **Step 6: Commit**

```bash
git add src/core/capabilities.ts src/core/routing.ts src/core/retry.ts src/core/policy.ts test/unit/routing.test.ts test/unit/retry.test.ts
git commit -m "feat: enforce routing and retry policy"
```

### Task 8: Build immutable worker assignments and evidence gates

**Files:**
- Create: `src/controller/assignment.ts`
- Create: `src/controller/result-gate.ts`
- Create: `src/controller/evidence.ts`
- Create: `src/defaults/superpowers-profile.ts`
- Test: `test/unit/assignment.test.ts`
- Test: `test/unit/result-gate.test.ts`

**Interfaces:**
- Consumes: `JobDefinition`, `Attempt`, effective policy, task graph, Git base, and `WorkerResult`.
- Produces: `buildAssignment(input): AssignmentBundle`; `acceptWorkerResult(input): AcceptedResult`; `DEFAULT_SUPERPOWERS_PROFILE`.

- [ ] **Step 1: Write failing assignment tests**

```ts
it("protects planning and harness paths", () => {
  const bundle = buildAssignment(assignmentInput());
  expect(bundle.protectedPaths).toEqual(expect.arrayContaining([
    ".harness/**", ".pi/**", "specs/**/spec.md", "specs/**/plan.md",
    "specs/**/tasks.md", "specs/**/task-graph.json",
  ]));
  expect(bundle.superpowers.allowed).toEqual([
    "test-driven-development", "systematic-debugging",
    "verification-before-completion", "requesting-code-review",
    "receiving-code-review",
  ]);
});

it("excludes nested orchestration skills", () => {
  const bundle = buildAssignment(assignmentInput());
  expect(bundle.superpowers.denied).toContain("subagent-driven-development");
  expect(bundle.superpowers.denied).toContain("dispatching-parallel-agents");
  expect(bundle.superpowers.denied).toContain("using-git-worktrees");
});
```

- [ ] **Step 2: Run assignment tests and verify failure**

Run: `npm test -- test/unit/assignment.test.ts`

Expected: FAIL because assignment construction is absent.

- [ ] **Step 3: Implement assignment canonicalization and hashing**

Include workflow/stage/job/item/attempt IDs, task and acceptance references, exact base commit, allowed and protected glob sets, named verification commands, result schema version, Superpowers mode, and absolute output path. Canonically hash the bundle and write it read-only under `assignments/<attemptId>.json` before launch.

- [ ] **Step 4: Write failing result-gate tests**

```ts
it("rejects self-reported discipline without independent evidence", () => {
  expect(() => acceptWorkerResult(resultInput({
    support: "injected",
    reportedDisciplines: ["test-driven-development"],
    commandEvidence: [],
  }))).toThrow(/independent evidence/);
});

it("rejects review approval for a superseded tree", () => {
  expect(() => acceptWorkerResult(reviewInput({ commitTree: "old-tree" })))
    .toThrow(/superseded commit tree/);
});
```

- [ ] **Step 5: Implement evidence gates**

Require schema-valid result files, matching IDs and assignment hash, expected commit/tree identity, command exit codes, evidence paths whose realpaths remain within `.harness-output/` without symlink escape, and no protected-path changes. Native Superpowers support requires adapter-observed invocation events; injected support requires Git, command, test, or review evidence and never accepts self-report alone.

- [ ] **Step 6: Run worker contract tests**

Run: `npm test -- test/unit/assignment.test.ts test/unit/result-gate.test.ts`

Expected: PASS with protected-path, stale-review, and evidence failures rejected.

- [ ] **Step 7: Commit**

```bash
git add src/controller/assignment.ts src/controller/result-gate.ts src/controller/evidence.ts src/defaults/superpowers-profile.ts test/unit/assignment.test.ts test/unit/result-gate.test.ts
git commit -m "feat: gate worker assignments and evidence"
```

### Task 9: Run the scheduler and controller against a fake runtime

**Files:**
- Create: `src/ports/runtime.ts`
- Create: `src/ports/clock.ts`
- Create: `src/core/scheduler.ts`
- Create: `src/controller/controller.ts`
- Create: `src/controller/reconcile.ts`
- Create: `src/runtime/fake-runtime.ts`
- Test: `test/unit/scheduler.test.ts`
- Test: `test/integration/controller.test.ts`

**Interfaces:**
- Consumes: compiled workflow, `RunLease`, reducer, routing, retry policy, and `AgentRuntime`.
- Produces: `AgentRuntime` interface; `schedule(state): readonly Decision[]`; `HarnessController.start`, `tick`, `stop`, and `recover`.

- [ ] **Step 1: Define the runtime port and write scheduler tests**

```ts
export interface AgentRuntime {
  probe(kind: WorkerKind): Promise<WorkerCapability>;
  prepare(request: PrepareRequest): Promise<PreparedWorker>;
  launch(request: LaunchRequest): Promise<RuntimeAttemptRef>;
  observe(ref: RuntimeAttemptRef): Promise<RuntimeObservation>;
  resume(ref: RuntimeAttemptRef): Promise<RuntimeObservation>;
  cancel(ref: RuntimeAttemptRef): Promise<void>;
  collect(ref: RuntimeAttemptRef): Promise<WorkerResult>;
  reconcile(idempotencyKey: string): Promise<RuntimeEffect | undefined>;
}
```

```ts
it("schedules independent jobs and waits for task dependencies", () => {
  const decisions = schedule(stateWithDiamondTasks());
  expect(decisions.filter((decision) => decision.kind === "launch").map((decision) => decision.jobId))
    .toEqual(["implement:T001", "implement:T002"]);
  expect(decisions).not.toContainEqual(expect.objectContaining({ jobId: "implement:T003" }));
});
```

- [ ] **Step 2: Run scheduler tests and verify failure**

Run: `npm test -- test/unit/scheduler.test.ts`

Expected: FAIL because scheduler and runtime ports are absent.

- [ ] **Step 3: Implement pure scheduling decisions**

Return decisions only for jobs whose stage dependencies, item scope, task dependencies, condition, and gate are satisfied. Sort by stage topological index and item key. Enforce global and per-worker concurrency without consulting wall-clock time inside the pure function.

- [ ] **Step 4: Write the crash-window controller test**

```ts
it("reconciles an effect after crashing between launch and observation", async () => {
  const runtime = new FakeRuntime({ crashAfterEffect: "launch:A1" });
  const first = controllerFixture(runtime);
  await expect(first.tick()).rejects.toThrow("injected crash");
  expect(runtime.launchCount("A1")).toBe(1);

  const recovered = controllerFixture(runtime, { recover: true });
  await recovered.recover();
  await recovered.tick();
  expect(runtime.launchCount("A1")).toBe(1);
  expect(recovered.state.attempts.A1.runtimeRef).toBeDefined();
});
```

- [ ] **Step 5: Implement intent/observation execution**

For every decision, append `<effect>.intent` with a stable key before calling the runtime. After success, append `<effect>.observed`. On startup, reconcile every intent lacking an observation before scheduling. Subscribe to runtime events when available and keep a bounded timer fallback; neither path invokes an LLM merely to poll.

- [ ] **Step 6: Add a complete fake-run integration test**

Run a diamond task graph through implement, independent review, verification, integration, and final verification. Assert two implementation jobs overlap, T003 starts only after T001/T002 integration, task checkboxes change only after projected `DONE`, and every state can be rebuilt from `events.jsonl` after deleting `state.json`.

- [ ] **Step 7: Run Milestone 1 verification**

Run: `npm test -- test/unit test/integration/controller.test.ts test/integration/state-store.test.ts && npm run typecheck`

Expected: PASS; the fake workflow completes with deterministic replay and no duplicate effect after the injected crash.

- [ ] **Step 8: Commit**

```bash
git add src/ports src/core/scheduler.ts src/controller/controller.ts src/controller/reconcile.ts src/runtime/fake-runtime.ts test/unit/scheduler.test.ts test/integration/controller.test.ts
git commit -m "feat: execute workflows with a durable controller"
```

## Milestone 2: Local Git and Herdr Execution

### Task 10: Manage planning, task branches, and serialized integration

**Files:**
- Create: `src/ports/command-executor.ts`
- Create: `src/ports/node-command-executor.ts`
- Create: `src/git/repository.ts`
- Create: `src/git/planning.ts`
- Create: `src/git/task-branch.ts`
- Create: `src/git/integrate.ts`
- Create: `src/git/changed-paths.ts`
- Test: `test/integration/git-repository.test.ts`
- Test: `test/integration/git-integration.test.ts`

**Interfaces:**
- Consumes: exact argv arrays, run ID, validated task graph, dependency commits, and assignment path policy.
- Produces: `GitRepository.inspect`, `createRunBranch`, `commitPlanningArtifacts`, `createTaskBranch`, `validateWorkerCommit`, `integrateTask`, `markTaskDone`, and `auditFinalDiff`.

- [ ] **Step 1: Define a no-shell command port and failing Git tests**

```ts
export interface CommandRequest {
  argv: readonly [string, ...string[]];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs?: number;
}

export interface CommandExecutor {
  run(request: CommandRequest): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
```

```ts
it("creates a task branch from the integration commit containing its dependencies", async () => {
  const repo = await tempGitRepository();
  const run = await repo.createRunBranch("F023", repo.initialCommit);
  await repo.recordIntegratedTask(run, "T001", dependencyCommit);
  const task = await repo.createTaskBranch(run, "T002", ["T001"]);
  expect(await repo.mergeBase(task.branch, run.branch)).toBe(run.head);
});
```

- [ ] **Step 2: Run Git tests and verify failure**

Run: `npm test -- test/integration/git-repository.test.ts test/integration/git-integration.test.ts`

Expected: FAIL because Git services are absent.

- [ ] **Step 3: Implement repository inspection and planning commit**

Use `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and `git status --porcelain=v2`. Refuse a non-repository, unresolved common directory, missing frozen base, or dirty protected planning paths. Create `harness/run-<runId>` and a controller-owned planning worktree; commit only declared Spec Kit artifacts and record commit/tree hashes.

- [ ] **Step 4: Implement worker commit validation**

Compare `<base>..HEAD`, require at least one worker commit for implementation actions, reject merge commits unless policy allows them, reject changed protected/out-of-scope paths, and verify every result SHA is reachable from the task branch. Use NUL-delimited Git output for filenames.

`auditFinalDiff` proves every changed path is attributable to an accepted planning artifact, validated worker commit, integration resolution, or controller checkbox commit; confirms the final tree contains every recorded integrated commit; and writes a hash-bound diff manifest for the PR action.

- [ ] **Step 5: Implement serialized integration and checkbox commits**

Acquire an integration mutex per run, cherry-pick validated worker commits onto the current run branch, run post-integration verification, then create a controller-authored checkbox commit that changes only the matching task marker. On conflict, abort the cherry-pick without discarding unrelated worktree state and return a typed `integration_conflict` result with paths and Git evidence.

- [ ] **Step 6: Add concurrency and conflict cases**

Test two independent branches created from one integration base, deterministic serialization of their commits, a real content conflict, an out-of-scope worker edit, and a worker attempt to edit `tasks.md`. Assert the latter two fail before integration.

- [ ] **Step 7: Run Git integration tests**

Run: `npm test -- test/integration/git-repository.test.ts test/integration/git-integration.test.ts`

Expected: PASS; conflicts are typed, protected files never enter worker commits, and the run branch retains completed work.

- [ ] **Step 8: Commit**

```bash
git add src/ports/command-executor.ts src/ports/node-command-executor.ts src/git test/integration/git-repository.test.ts test/integration/git-integration.test.ts test/support/temp-git-repository.ts
git commit -m "feat: integrate isolated task branches"
```

### Task 11: Execute registered workflow actions without hard-coded stage names

**Files:**
- Create: `src/actions/types.ts`
- Create: `src/actions/registry.ts`
- Create: `src/ports/approval.ts`
- Create: `src/actions/command.ts`
- Create: `src/actions/human-approval.ts`
- Create: `src/actions/git-integrate.ts`
- Create: `src/actions/github-pull-request.ts`
- Test: `test/unit/action-registry.test.ts`
- Test: `test/integration/actions.test.ts`

**Interfaces:**
- Consumes: compiled `uses`, action input, `CommandExecutor`, `GitRepository`, and `ApprovalPort`.
- Produces: `ActionRegistry.register(name, handler)` and `ActionRegistry.execute(name, context)`; built-ins `command.run`, `human.approval`, `git.integrate`, and `github.pull-request`.

- [ ] **Step 1: Write failing action-registry tests**

```ts
it("dispatches by uses instead of stage name", async () => {
  const registry = new ActionRegistry();
  registry.register("example.echo", async (context) => ({ outputs: { value: context.input } }));
  await expect(registry.execute("example.echo", actionContext("hello")))
    .resolves.toEqual({ outputs: { value: "hello" } });
  await expect(registry.execute("review", actionContext("hello"))).rejects.toThrow(/unregistered action/);
});
```

- [ ] **Step 2: Run action tests and verify failure**

Run: `npm test -- test/unit/action-registry.test.ts test/integration/actions.test.ts`

Expected: FAIL because no registry or handlers exist.

- [ ] **Step 3: Implement action contracts and command execution**

```ts
export interface ActionContext {
  runId: string;
  jobId: string;
  attemptId: string;
  cwd: string;
  input: unknown;
  signal: AbortSignal;
  idempotencyKey: string;
}

export type ActionHandler = (context: ActionContext) => Promise<{
  outputs?: Readonly<Record<string, unknown>>;
  evidence?: readonly string[];
}>;
```

`command.run` accepts only a compiled `argv` command object and calls `spawn` with `shell: false`. It streams bounded redacted logs, enforces timeout/cancellation, records exit code, and fails on nonzero exit.

- [ ] **Step 4: Implement approval, integration, and pull-request actions**

`human.approval` returns `BLOCKED` without an attached interactive UI and records the exact workflow hash shown to the approver. `git.integrate` delegates to Task 10. `github.pull-request` requires successful full verification, calls `auditFinalDiff`, records its hash-bound evidence, probes `gh auth status`, verifies the configured remote host, pushes only the run branch, then calls `gh pr create --head <branch> --base <base> --title <title> --body-file <path>` and reconciles with `gh pr view <branch> --json url` before retrying.

- [ ] **Step 5: Test no-shell and PR idempotency behavior**

Pass an argument containing `$(touch sentinel)` and assert no sentinel file is created. Simulate a crash after `gh pr create` and assert reconciliation returns the existing URL without issuing a second create.

Emit a fake `OPENAI_API_KEY=known-secret` line larger than the configured log limit; assert stored and displayed logs omit `known-secret`, include a redaction marker, and retain only the bounded tail. Keep the test explicit that redaction does not authorize passing production credentials to the process.

- [ ] **Step 6: Run action tests**

Run: `npm test -- test/unit/action-registry.test.ts test/integration/actions.test.ts`

Expected: PASS; arbitrary stage IDs dispatch correctly, shell metacharacters stay literal, and PR creation is idempotent.

- [ ] **Step 7: Commit**

```bash
git add src/actions src/ports/approval.ts test/unit/action-registry.test.ts test/integration/actions.test.ts
git commit -m "feat: register deterministic workflow actions"
```

### Task 12: Implement the Herdr socket client and local runtime

**Files:**
- Create: `src/runtime/herdr/transport.ts`
- Create: `src/runtime/herdr/protocol.ts`
- Create: `src/runtime/herdr/cli.ts`
- Create: `src/runtime/herdr/socket-client.ts`
- Create: `src/runtime/herdr/runtime.ts`
- Create: `src/runtime/herdr/event-cache.ts`
- Test: `test/unit/herdr-client.test.ts`
- Test: `test/integration/herdr-runtime.test.ts`

**Interfaces:**
- Consumes: Herdr local socket path, `AgentRuntime`, absolute repository/worktree paths, and worker launch specifications.
- Produces: `HerdrCli.run`; `HerdrClient.request`, `subscribe`, `snapshot`; `HerdrRuntime` implementing every `AgentRuntime` method.

- [ ] **Step 1: Write failing request-correlation tests**

```ts
it("correlates out-of-order socket responses", async () => {
  const transport = new FakeHerdrTransport();
  const client = new HerdrClient(transport);
  const first = client.request("agent.get", { agent: "a" });
  const second = client.request("agent.get", { agent: "b" });
  transport.respondTo(2, { agent: { name: "b", status: "idle" } });
  transport.respondTo(1, { agent: { name: "a", status: "working" } });
  await expect(first).resolves.toMatchObject({ agent: { name: "a" } });
  await expect(second).resolves.toMatchObject({ agent: { name: "b" } });
});
```

- [ ] **Step 2: Run Herdr client tests and verify failure**

Run: `npm test -- test/unit/herdr-client.test.ts`

Expected: FAIL because the protocol client is absent.

- [ ] **Step 3: Implement newline-delimited request/response and subscriptions**

Assign monotonically increasing request IDs, validate response envelopes, reject pending calls on disconnect, and reconnect with bounded backoff. To avoid a bootstrap gap, open `events.subscribe`, wait for acknowledgement, buffer events, call `session.snapshot`, install the snapshot, then apply buffered events in sequence. Refresh the snapshot after reconnect.

- [ ] **Step 4: Map Herdr operations to the runtime port**

Implement `HerdrCli` as exact argv calls with JSON response validation for one-shot probes, workspace creation, and worktree create/open/remove operations. Use the raw socket for the long-lived event stream, snapshot bootstrap, atomic prompt-and-wait, and low-latency agent observation. Start agents with explicit `kind`, pane, stable name, and timeout; prompt without interpreting prose; retain native IDs for reconciliation. Map only exact Herdr states `working`, `blocked`, `idle`, `done`, and `unknown`; never map `idle`, `done`, or `unknown` to success without a valid result file.

Implement cancellation with `agent.send_keys` using `ctrl+c`, then observe the pinned agent identity until it settles or the cancellation timeout becomes a typed failure. `resume` first verifies the recorded agent still owns its pane; otherwise reconciliation returns `undefined` and retry policy decides the next attempt.

- [ ] **Step 5: Add protocol-fixture integration coverage**

Replay fixtures for worktree creation, blocked startup, agent replacement in a pane, disconnect/reconnect, duplicate events, and `unknown` status. Assert worktree paths are absolute, agent names match `[a-z][a-z0-9_-]{0,31}`, and replacement agents cannot satisfy an old wait.

- [ ] **Step 6: Run Herdr runtime tests**

Run: `npm test -- test/unit/herdr-client.test.ts test/integration/herdr-runtime.test.ts`

Expected: PASS using the fake socket server; no live Herdr installation is needed for this gate.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/herdr test/unit/herdr-client.test.ts test/integration/herdr-runtime.test.ts test/support/fake-herdr-server.ts test/fixtures/herdr
git commit -m "feat: add Herdr execution runtime"
```

### Task 13: Add Codex, Devin, and Claude worker adapters

**Files:**
- Create: `src/runtime/workers/types.ts`
- Create: `src/runtime/workers/base.ts`
- Create: `src/runtime/workers/codex.ts`
- Create: `src/runtime/workers/devin.ts`
- Create: `src/runtime/workers/claude.ts`
- Create: `src/runtime/workers/registry.ts`
- Create: `src/actions/worker.ts`
- Test: `test/contract/worker-adapter.contract.ts`
- Test: `test/contract/codex-adapter.test.ts`
- Test: `test/contract/devin-adapter.test.ts`
- Test: `test/contract/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `AssignmentBundle`, `HerdrRuntime`, and worker-kind probes.
- Produces: `WorkerAdapter`; `WorkerAdapterRegistry`; adapters with Herdr kinds `codex`, `devin`, and `claude`; registered actions `worker.execute` and `worker.review`.

- [ ] **Step 1: Define the shared adapter contract suite**

```ts
export interface WorkerAdapter {
  readonly kind: "codex" | "devin" | "claude";
  probe(): Promise<WorkerCapability>;
  launchSpec(assignment: AssignmentBundle): WorkerLaunchSpec;
  prompt(assignment: AssignmentBundle): string;
  collect(assignment: AssignmentBundle): Promise<WorkerResult>;
}

export function workerAdapterContract(factory: AdapterFactory): void {
  it("binds prompts to immutable assignment and output paths", async () => {
    const adapter = factory();
    const prompt = adapter.prompt(contractAssignment());
    expect(prompt).toContain(contractAssignment().assignmentHash);
    expect(prompt).toContain(contractAssignment().resultPath);
    expect(prompt).toContain("Do not edit protected paths");
  });

  it("does not forward production credentials", () => {
    const adapter = factory({ env: { PATH: "/bin", PROD_DATABASE_URL: "secret" } });
    expect(adapter.launchSpec(contractAssignment()).env).toEqual({ PATH: "/bin" });
  });
}
```

- [ ] **Step 2: Run all adapter suites and verify failure**

Run: `npm test -- test/contract`

Expected: FAIL because adapters do not exist.

- [ ] **Step 3: Implement the common adapter behavior**

Generate prompts from one structured template that states the task, exact base, allowed/protected paths, acceptance references, required commands, Superpowers allow/deny lists, and result schema path. Probe executable/version/authentication and isolation capability separately. Build launch environments from an allowlist, excluding production credential patterns, and pass declared process, filesystem, and network limits to a native sandbox/container wrapper when available. Report `unrestricted-host` honestly and let policy block it when stronger isolation is required. Detect native Superpowers only from verifiable integration metadata; otherwise report `injected` and require independent evidence.

- [ ] **Step 4: Implement each Herdr launch specification**

Codex uses Herdr kind `codex`, Devin uses `devin`, and Claude uses `claude`. Pass only policy-approved model/profile flags after `--`; do not embed credentials or free-form shell. Give each attempt a stable name derived from run, job, and attempt IDs and shorten it deterministically to Herdr's 32-character limit.

- [ ] **Step 5: Implement result collection**

Read only the assignment's absolute `.harness-output/result.json`, validate through Task 2, hash referenced evidence, and return it to the controller. Missing/malformed results, mismatched assignment hashes, or evidence outside the output directory fail the attempt even if the terminal says it completed.

- [ ] **Step 6: Register worker actions**

`worker.execute` and `worker.review` select the already-recorded routing decision, build the immutable assignment, ask Herdr to prepare/launch/prompt the matching adapter, and return pending until a structured result is collectible. Review action success requires `approved`; `changes_requested` returns the typed failure consumed by the compiled remediation policy.

- [ ] **Step 7: Run the shared contract suite**

Run: `npm test -- test/contract`

Expected: PASS for Codex, Devin, and Claude against fake executable and Herdr fixtures.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/workers src/actions/worker.ts test/contract
git commit -m "feat: add Codex Devin and Claude adapters"
```

### Task 14: Integrate Spec Kit planning and graph generation

**Files:**
- Create: `presets/harness-task-graph/preset.yml`
- Create: `presets/harness-task-graph/commands/speckit.tasks.md`
- Create: `src/speckit/preset.ts`
- Create: `src/speckit/artifacts.ts`
- Create: `src/actions/spec-kit.ts`
- Create: `src/ports/planning-agent.ts`
- Test: `test/unit/speckit-artifacts.test.ts`
- Test: `test/unit/speckit-preset.test.ts`
- Test: `test/integration/speckit-preset.real.test.ts`

**Interfaces:**
- Consumes: Spec Kit CLI, `PlanningAgentPort`, Task 4 graph validator, and declared feature directory.
- Produces: actions `spec-kit.specify`, `spec-kit.plan`, and `spec-kit.tasks`; accepted content-addressed planning artifacts.

- [ ] **Step 1: Write failing preset-resolution tests**

```ts
it("wraps the core tasks command and preserves command metadata", async () => {
  const resolved = await resolvePresetInTempProject();
  expect(resolved).toContain("argument-hint:");
  expect(resolved).toContain("Generate task-graph.json using harness/task-graph/v1");
  expect(resolved).toContain("Create tasks.md");
});
```

- [ ] **Step 2: Run Spec Kit tests and verify failure**

Run: `npm test -- test/unit/speckit-preset.test.ts`

Expected: FAIL because the preset does not exist.

- [ ] **Step 3: Create the versioned wrap preset**

Declare command name `speckit.tasks`, type `command`, strategy `wrap`, and an explicit `argument-hint` in both preset metadata and command frontmatter. Put `{CORE_TEMPLATE}` once in the wrapper. After the core instructions, require `tasks.md` and `task-graph.json` to be emitted together, with explicit dependency IDs, file scopes, acceptance references, parallel eligibility, and the normalized semantic hash. The normal unit test composes the wrapper with a recorded core-command fixture; the real Spec Kit resolver test is gated by `HARNESS_E2E_SPECKIT=1` and runs in Task 18.

- [ ] **Step 4: Implement planning actions and direct validation**

```ts
export interface PlanningAgentPort {
  enqueue(command: "speckit.specify" | "speckit.plan" | "speckit.tasks", input: string, correlationId: string): Promise<void>;
  observe(correlationId: string): Promise<"pending" | "turn-ended">;
}
```

Each action enqueues one correlated Pi turn and remains pending until `turn-ended`. It accepts success only from expected artifact files, never model prose. `spec-kit.tasks` immediately loads both outputs, validates schema/hash/IDs/references with Task 4, copies them content-addressed into the run, asks `GitRepository.commitPlanningArtifacts` to bind the complete planning set to the integration branch, records the commit/tree hashes, and only then allows fan-out. A Spec Kit hook may invoke the same validator for convenience but cannot replace this controller call.

- [ ] **Step 5: Test stale, partial, and ambiguous outputs**

Cover missing graph, graph without tasks file, stale hash, duplicate task ID, unknown acceptance reference, one valid generated pair, and an existing-approved-artifacts workflow that binds clean paths, hashes, and their containing commit without invoking Pi planning. Assert no `implement` job materializes for any rejected or unbound pair.

- [ ] **Step 6: Run Milestone 2 verification**

Run: `npm test -- test/unit test/contract test/integration && npm run typecheck`

Expected: PASS using fake GitHub, Herdr, workers, and planning ports.

- [ ] **Step 7: Commit**

```bash
git add presets/harness-task-graph src/speckit src/actions/spec-kit.ts src/ports/planning-agent.ts test/unit/speckit-artifacts.test.ts test/unit/speckit-preset.test.ts test/integration/speckit-preset.real.test.ts
git commit -m "feat: integrate Spec Kit task graphs"
```

## Milestone 3: Pi Package and Machine Lifecycle

### Task 15: Run the resident controller inside a Pi extension

**Files:**
- Create: `src/pi/extension.ts`
- Create: `src/pi/controller-registry.ts`
- Create: `src/pi/planning-agent.ts`
- Create: `src/pi/model-profiles.ts`
- Create: `src/pi/approval.ts`
- Create: `src/pi/commands.ts`
- Create: `src/pi/status-view.ts`
- Test: `test/unit/pi-extension.test.ts`
- Test: `test/integration/pi-residency.test.ts`

**Interfaces:**
- Consumes: Pi `ExtensionAPI`, canonical repository identity, `HarnessController`, `PlanningAgentPort`, and `ApprovalPort`.
- Produces: default Pi extension; semantic commands `/harness-run`, `/harness-status`, `/harness-graph`, `/harness-task`, `/harness-logs`, `/harness-retry`, `/harness-reroute`, `/harness-cancel`, `/harness-pause`, `/harness-resume`, and `/harness-doctor`.

- [ ] **Step 1: Write failing command-registration tests**

```ts
it("registers every semantic harness command", () => {
  const pi = new FakeExtensionApi();
  registerHarnessExtension(pi);
  expect(pi.commandNames()).toEqual([
    "harness-run", "harness-status", "harness-graph", "harness-task",
    "harness-logs", "harness-retry", "harness-reroute", "harness-cancel",
    "harness-pause", "harness-resume", "harness-doctor",
  ]);
});
```

- [ ] **Step 2: Run Pi extension tests and verify failure**

Run: `npm test -- test/unit/pi-extension.test.ts`

Expected: FAIL because the extension entrypoint is absent.

- [ ] **Step 3: Implement the extension and controller registry**

Export a default factory accepting `ExtensionAPI`. On `session_start`, resolve the canonical repository and recover active run metadata, but do not start a new run. Keep one `HarnessController` per canonical run in a process-local registry. Controller timers and Herdr event subscriptions live outside LLM turns; a `turn_end` listener only wakes pending Pi planning actions.

- [ ] **Step 4: Implement Pi planning and approval ports**

Resolve the committed logical profile `chatgpt-planning` through machine-local Pi settings, require an authenticated ChatGPT subscription-backed model, and never copy its credentials into project or run state. `PiPlanningAgent.enqueue` applies that resolved model/profile, calls `pi.sendUserMessage` with the exact `/speckit.*` command, correlation ID, expected output paths, and instruction to make no orchestration decisions, then restores the prior interactive model after the correlated turn. If Pi is busy, queue as `deliverAs: "followUp"`; otherwise trigger the turn normally. Approval handlers use `ctx.ui.confirm` only when UI is attached; detached approvals persist as `BLOCKED` until an explicit operator command.

- [ ] **Step 5: Implement semantic commands and status UI**

`/harness-run` compiles and displays the workflow hash, commands, workers, credential profiles, permissions, branches, push, and PR effects before confirmation. Status commands read snapshots and evidence without prompting a model. Retry/reroute commands validate policy and append operator-intent events rather than mutating state directly. Show run/task/worker/blocker summaries via Pi widgets and notifications.

- [ ] **Step 6: Prove scheduling continues while the model is idle**

```ts
it("advances worker stages without another Pi turn", async () => {
  const clock = new FakeClock();
  const runtime = new FakeRuntime();
  const pi = new FakeExtensionApi({ idle: true });
  const extension = registerHarnessExtension(pi, fixtureDependencies({ clock, runtime }));
  await extension.startExistingRun("F023");
  runtime.complete("implement:T001", completedResult());
  await clock.advanceBy(100);
  expect(extension.controller.state.jobs["review:T001"].state).toBe("RUNNING");
  expect(pi.sentMessages).toHaveLength(0);
});
```

- [ ] **Step 7: Test pause, resume, cancellation, retry, and reroute commands**

Assert pause prevents new launches but leaves active attempts observable; resume re-evaluates readiness; cancel calls the runtime once and records observation; retry creates a new immutable attempt within budget; reroute rejects an undeclared or policy-ineligible worker. Replaying the operator events must produce the same state without reissuing completed effects.

Add model-profile cases proving a missing `chatgpt-planning` mapping blocks before a planning turn, an authenticated ChatGPT-backed mapping is selected for Spec Kit, the prior model is restored afterward, and no credential value enters events, snapshots, logs, or artifacts.

- [ ] **Step 8: Run Pi residency tests**

Run: `npm test -- test/unit/pi-extension.test.ts test/integration/pi-residency.test.ts`

Expected: PASS; deterministic stages advance while Pi is idle and no polling turn is generated.

- [ ] **Step 9: Commit**

```bash
git add src/pi test/unit/pi-extension.test.ts test/integration/pi-residency.test.ts test/support/fake-extension-api.ts
git commit -m "feat: host the controller in Pi"
```

### Task 16: Generate an immediately runnable project configuration

**Files:**
- Create: `src/defaults/workflow.yaml`
- Create: `src/defaults/environment.yaml`
- Create: `src/defaults/policy.yaml`
- Create: `src/defaults/harness.lock.json`
- Create: `src/cli/main.ts`
- Create: `src/cli/init.ts`
- Create: `src/cli/command-detection.ts`
- Create: `src/cli/config-merge.ts`
- Test: `test/integration/init.test.ts`
- Test fixtures: `test/fixtures/projects/node/`
- Test fixtures: `test/fixtures/projects/python/`

**Interfaces:**
- Consumes: trusted CLI invocation, project manifests, repository path, and optional explicit `--task-verify`/`--full-verify` argv values.
- Produces: `harness init`; complete `.harness/` and `.pi/settings.json` project configuration.

- [ ] **Step 1: Write failing initialization tests**

```ts
it("creates a complete default workflow for a Node project", async () => {
  const repo = await copyProjectFixture("node");
  await runHarness(["init", repo]);
  const workflow = await loadYaml(`${repo}/.harness/workflow.yaml`);
  const environment = await loadYaml(`${repo}/.harness/environment.yaml`);
  expect(workflow.stages.map((stage: { id: string }) => stage.id)).toEqual([
    "specify", "plan", "approve_plan", "tasks", "implement", "review",
    "verify", "integrate", "final_verify", "final_pr",
  ]);
  expect(environment.commands.task_verify.argv[0]).toBe("npm");
});

it("does not overwrite customized configuration", async () => {
  const repo = await initializedFixture({ workflowName: "custom" });
  await expect(runHarness(["init", repo])).rejects.toThrow(/already exists/);
  expect((await loadYaml(`${repo}/.harness/workflow.yaml`)).name).toBe("custom");
});
```

- [ ] **Step 2: Run init tests and verify failure**

Run: `npm test -- test/integration/init.test.ts`

Expected: FAIL because the CLI and defaults do not exist.

- [ ] **Step 3: Create the default DSL and policy files**

Materialize the design's full Spec Kit -> Devin/Codex/Claude -> review -> verify -> integrate -> final PR workflow. Set implementation preference `[devin, codex, claude]`, review preference `[codex, claude, devin]`, finite retry budgets, worktree isolation, independent review, protected planning paths, and `${commands.task_verify}`/`${commands.full_verify}` references. Include editable example workflows under `.harness/workflows/examples/`.

- [ ] **Step 4: Implement deterministic command detection**

Read declarative manifests only. For Node, prefer existing `test` and `check` package scripts without running lifecycle scripts; for Python, recognize `pyproject.toml` pytest configuration. If exactly one safe candidate exists, write its argv. If zero or multiple candidates exist in an interactive terminal, request explicit argv; in noninteractive mode, fail with `--task-verify` and `--full-verify` instructions instead of writing placeholders.

- [ ] **Step 5: Implement non-destructive config generation**

Create `.harness/workflow.yaml`, `environment.yaml`, `policy.yaml`, `harness.lock`, examples, and `.pi/settings.json` atomically. Merge only the exact pinned package source into Pi's project package list, and idempotently add `.harness-output/` to the target repository's `.gitignore`. Refuse existing files unless `--repair` can prove the existing semantic content equals the generated content; never use a broad force overwrite.

Resolve packaged templates by walking from `import.meta.url` to the nearest `package.json` whose name is `@pi-harness/cli`, then reading `src/defaults/` and `presets/` beneath that root. Never resolve package assets relative to the operator's current working directory.

- [ ] **Step 6: Validate every generated file through production schemas**

Compile the generated workflow, verify all named commands resolve, confirm the package source is pinned, and print the next trusted bootstrap command. Add tests for Node, Python, ambiguous detection, preexisting customization, non-Git directory, and paths containing spaces.

- [ ] **Step 7: Run initialization tests**

Run: `npm test -- test/integration/init.test.ts && npm run typecheck`

Expected: PASS; every successful init produces a runnable, schema-valid DSL with no placeholder command.

- [ ] **Step 8: Commit**

```bash
git add src/defaults src/cli test/integration/init.test.ts test/fixtures/projects
git commit -m "feat: initialize runnable harness workflows"
```

### Task 17: Bootstrap, diagnose, start, and recover a machine safely

**Files:**
- Create: `src/install/types.ts`
- Create: `src/install/trust.ts`
- Create: `src/install/probes.ts`
- Create: `src/install/plan.ts`
- Create: `src/install/recipes.ts`
- Create: `src/install/receipts.ts`
- Create: `src/cli/bootstrap.ts`
- Create: `src/cli/doctor.ts`
- Create: `src/cli/start.ts`
- Create: `src/cli/status.ts`
- Create: `src/cli/recover.ts`
- Test: `test/integration/bootstrap.test.ts`
- Test: `test/integration/operations.test.ts`

**Interfaces:**
- Consumes: declarative `.harness/*.yaml`, `harness.lock`, external machine policy, Git metadata, trusted installer recipes, Herdr client, and run repository.
- Produces: `harness bootstrap [--dry-run|--repair|--yes]`, `doctor [--json]`, `explain`, `graph`, `start`, `status`, and `recover`.

- [ ] **Step 1: Write the pre-approval execution trap test**

```ts
it("never executes repository content before approval", async () => {
  const repo = await maliciousProjectFixture({
    packageLifecycleScript: "node -e \"require('fs').writeFileSync('owned','yes')\"",
    workflowCommand: ["node", "-e", "require('fs').writeFileSync('owned2','yes')"],
  });
  await runHarness(["bootstrap", "--dry-run", repo]);
  expect(await exists(`${repo}/owned`)).toBe(false);
  expect(await exists(`${repo}/owned2`)).toBe(false);
});
```

- [ ] **Step 2: Run bootstrap tests and verify failure**

Run: `npm test -- test/integration/bootstrap.test.ts`

Expected: FAIL because bootstrap does not exist.

- [ ] **Step 3: Implement trust evaluation and install planning**

Load the machine ceiling from `${XDG_CONFIG_HOME:-$HOME/.config}/pi-harness/policy.yaml`, treating absence as the deny-by-default built-in policy. Read only harness YAML/lock and Git metadata before approval. Compare probes with exact locked versions/digests and emit an ordered plan containing source, integrity, command argv, global/project scope, expected files, rollback, and whether the step is automatic or manual.

The plan must enumerate Pi, the pinned `@pi-harness/cli` Pi package, Spec Kit, the `harness-task-graph` preset, Superpowers, Herdr, Herdr integrations for Pi/Codex/Devin/Claude, Codex CLI, Devin CLI, Claude Code, Git, and GitHub CLI. Missing ChatGPT/worker authentication is a manual blocking probe, not an install recipe.

- [ ] **Step 4: Implement typed recipes and receipts**

Support exact-version npm, allowlisted package-manager formula, signed artifact plus digest, and manual recipes. Execute with `shell: false`; forbid floating refs and arbitrary downloaded scripts. `--yes` is valid only when every planned automatic mutation is locked and allowed by machine policy; otherwise require the interactive plan approval. Stop on manual dependencies with exact instructions, then re-probe on `--repair`. Store secret-free receipts in `${XDG_STATE_HOME:-$HOME/.local/state}/pi-harness/receipts/`, but make `doctor` trust fresh probes rather than receipts.

- [ ] **Step 5: Implement doctor and machine-readable diagnostics**

Probe Node, Git, GitHub CLI/auth/remote, Pi package/version/ChatGPT profile, Spec Kit and preset resolution, Superpowers profile, Herdr server/integrations, Codex, Devin, Claude, machine policy, project config, and runtime directories. `--json` returns one schema-versioned object and nonzero exit on missing required capability; redact tokens and credential values.

- [ ] **Step 6: Implement `harness start`**

Resolve the project, ensure Herdr is reachable, create or find a dedicated workspace labeled with the canonical repository identity, capture its root pane, and call `agent.start` with kind `pi`, a stable name, and project cwd. Reconcile an existing live Pi agent rather than launching a duplicate. Wait until Pi is `idle` and verify the harness extension reports ready.

- [ ] **Step 7: Implement read-only status and explicit recovery**

`status`, `graph`, and `explain` read validated snapshots/events only. `recover` acquires a new fencing token, validates the full event chain, reconciles intents, Herdr sessions, worktrees, branches, commits, and results, then persists proposed state. It never schedules new work while Pi is unavailable; `start` hands the recovered run back to the resident controller.

- [ ] **Step 8: Add idempotency, malicious-input, and restart tests**

Cover two bootstrap runs, partial install then repair, wrong checksum, untrusted source, manual dependency, lock mismatch, paths with spaces, malicious npm lifecycle scripts, duplicate `start`, torn event tail, and interior corruption. Assert only an incomplete tail is repairable and an existing Herdr Pi agent is reused.

- [ ] **Step 9: Run Milestone 3 verification**

Run: `npm test -- test/integration/bootstrap.test.ts test/integration/operations.test.ts test/unit/pi-extension.test.ts test/integration/pi-residency.test.ts && npm run typecheck`

Expected: PASS; dry-run performs no repository execution, bootstrap is idempotent, and start/recover never duplicates the controller.

- [ ] **Step 10: Commit**

```bash
git add src/install src/cli package.json test/integration/bootstrap.test.ts test/integration/operations.test.ts test/fixtures/install
git commit -m "feat: bootstrap and recover harness machines"
```

## Milestone 4: End-to-End Hardening and Release

### Task 18: Prove the acceptance criteria and package the release

**Files:**
- Create: `test/e2e/fake-feature.test.ts`
- Create: `test/e2e/crash-matrix.test.ts`
- Create: `test/e2e/real-smoke.test.ts`
- Create: `test/e2e/fixtures/sample-feature/`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `SECURITY.md`
- Create: `docs/installation.md`
- Create: `docs/workflow-dsl.md`
- Create: `docs/recovery.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: every public contract and command from Tasks 1-17.
- Produces: release gate `npm run verify`; packed npm/Pi artifact; opt-in real integration smoke suite.

- [ ] **Step 1: Write a black-box fake feature test**

```ts
it("takes a planned feature through parallel implementation to one PR", async () => {
  const system = await createBlackBoxHarness({
    graph: diamondTaskGraph(),
    unavailableWorkers: [],
  });
  const result = await system.runToQuiescence();
  expect(result.taskStates).toEqual({ T001: "DONE", T002: "DONE", T003: "DONE" });
  expect(result.maxConcurrentImplementation).toBe(2);
  expect(result.reviews.every((review) => review.worker !== review.implementationWorker)).toBe(true);
  expect(result.pullRequests).toHaveLength(1);
  expect(result.pullRequests[0].commits).toEqual(expect.arrayContaining(result.integratedCommits));
});
```

- [ ] **Step 2: Run the black-box test and verify any missing wiring fails**

Run: `npm test -- test/e2e/fake-feature.test.ts`

Expected: FAIL until the CLI, controller, action registry, fake ports, and final PR output are wired through the package entrypoint.

- [ ] **Step 3: Wire the complete package and make the fake feature pass**

Expose a composition root that creates schemas, repository, action registry, runtime, adapters, controller, and CLI dependencies without global hidden state. The fake test must invoke the same CLI/controller entrypoints as production and replace only explicit ports.

- [ ] **Step 4: Add the crash and fallback matrix**

Inject termination before and after event append, runtime launch, worker result write, Git commit, cherry-pick, checkbox commit, push, and PR creation. Add Devin unavailable -> Codex implementation -> Claude review, reviewer unavailable -> `BLOCKED`, specification blocker, authentication blocker, verification remediation, integration conflict, and retry exhaustion. For every case, restart from disk and assert no duplicate attempts/effects, skipped dependencies, stale review approvals, or lost evidence.

- [ ] **Step 5: Add opt-in real smoke tests**

Guard live tests with `HARNESS_E2E_REAL=1`. In a disposable Git repository, run `doctor`, resolve the real Spec Kit wrap preset with `HARNESS_E2E_SPECKIT=1`, start Herdr, execute one no-op task separately through Codex, Devin, and Claude, validate result collection, then remove disposable worktrees. Do not push or open a PR unless `HARNESS_E2E_GITHUB_REPO` names an explicitly disposable repository.

- [ ] **Step 6: Add CI and package smoke verification**

Run Node 22 CI jobs for `npm ci`, `npm run typecheck`, unit/contract/integration/fake-e2e tests, build, and `npm pack`. Install the produced tarball into a fresh temp directory, invoke `harness --help`, and load the packaged Pi extension with a fake `ExtensionAPI`. Keep real subscription tests manual/gated.

Add this release script:

```json
{
  "scripts": {
    "verify": "npm run typecheck && npm test && npm run build && npm pack --dry-run"
  }
}
```

- [ ] **Step 7: Document installation, DSL, security, and recovery**

`README.md` gives the trusted exact-version bootstrap command and default workflow. `docs/installation.md` distinguishes install approval, authentication, and run approval. `docs/workflow-dsl.md` documents schemas, fan-out, `all`, `same-item`, task projection, remediation, and frozen revisions with complete YAML examples. `SECURITY.md` documents machine policy, protected paths, credential exclusion, and vulnerability reporting. `docs/recovery.md` documents fencing, tail repair, interior corruption, and operator commands.

- [ ] **Step 8: Run the complete release gate**

Run: `npm run verify`

Expected: PASS with zero test failures, successful TypeScript build, and an npm dry-run package containing `dist/`, `bin/harness.mjs`, `presets/`, and `src/defaults/` but no tests, credentials, run state, or `.harness-output/`.

- [ ] **Step 9: Inspect the packed artifact**

Run: `npm pack --dry-run --json`

Expected: the JSON file list contains only declared release content; package size and executable mode are reported, and `bin/harness.mjs` is present.

- [ ] **Step 10: Commit**

```bash
git add test/e2e .github/workflows/ci.yml README.md SECURITY.md docs/installation.md docs/workflow-dsl.md docs/recovery.md package.json package-lock.json src
git commit -m "test: prove end-to-end harness delivery"
```

## Execution Order and Review Gates

Execute tasks strictly in numeric order because each public interface is consumed by later tasks. After Tasks 5, 9, 14, 17, and 18, stop for an independent review of the entire milestone before proceeding. A milestone review must check the current spec, public interfaces, event/recovery invariants, security boundary, and test evidence; review approval is not inferred from a green test suite.

The real-agent smoke test is deliberately last and gated. No implementation task before Task 18 requires spending Codex, Devin, Claude, or ChatGPT subscription usage; fake ports and contract fixtures provide the normal development loop.

## Implementation References

- [Pi package format and peer dependencies](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Spec Kit preset composition](https://github.com/github/spec-kit/blob/main/docs/reference/presets.md)
- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
- [Herdr socket API](https://herdr.dev/docs/socket-api/)
- [Devin CLI](https://docs.devin.ai/cli)
