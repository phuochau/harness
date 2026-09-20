# Pi Orchestrator Phase 1: Package and Deterministic Contracts Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Produce a loadable package and deterministic workflow/task-graph core with exact schemas and typed fixtures.

**Architecture:** This phase contains no external side effects. TypeBox owns wire formats, the compiler freezes a normalized workflow, and graph materialization produces stable job IDs consumed by all later phases.

**Tech Stack:** Node.js 22+, TypeScript ESM, `@sinclair/typebox`, Ajv, YAML, Vitest, fast-check.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Task 1: Scaffold a Loadable Package, CLI, and Extension Stub

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/index.ts`, `src/cli/main.ts`, `src/pi/extension.ts`, `bin/harness.mjs`
- Test: `test/integration/package-smoke.test.ts`

**Interfaces:**
- Produces `main(argv: readonly string[]): Promise<number>` and Pi default extension factory.
- Package name is exactly `pi-multi-agent-harness`; bin name is `harness`.

- [ ] **Step 1: Write the failing package smoke test**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";

it("packs a runnable CLI and loadable extension", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.name).toBe("pi-multi-agent-harness");
  expect(pkg.pi.extensions).toEqual(["./dist/pi/extension.js"]);
  const cwd = await mkdtemp(join(tmpdir(), "harness-package-"));
  const result = await execa(process.execPath, ["bin/harness.mjs", "--help"], { cwd: process.cwd() });
  expect(result.stdout).toContain("harness");
  expect(cwd).toBeTruthy();
});
```

- [ ] **Step 2: Run the test and observe the missing package failure**

Run: `npm test -- test/integration/package-smoke.test.ts`

Expected: FAIL because the package and entrypoints do not exist.

- [ ] **Step 3: Create the package and working entrypoints**

```json
{
  "name": "pi-multi-agent-harness",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "harness": "./bin/harness.mjs" },
  "exports": {
    ".": "./dist/index.js",
    "./extension": "./dist/pi/extension.js"
  },
  "files": ["dist", "bin", "presets", "src/defaults"],
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./dist/pi/extension.js"] },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "check:phase1": "npm run typecheck && vitest run test/unit/contracts test/unit/config test/unit/graph test/integration/package-smoke.test.ts"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  }
}
```

Run:

```bash
npm install --save-exact ajv commander execa proper-lockfile yaml
npm install --save-dev --save-exact @mariozechner/pi-coding-agent@0.73.1 @sinclair/typebox@0.34.52 @types/node @types/proper-lockfile fast-check typescript vitest
```

```ts
// src/cli/main.ts
import { Command } from "commander";

export async function main(argv: readonly string[]): Promise<number> {
  const program = new Command().name("harness").description("Pi multi-agent orchestrator");
  program.command("version").action(() => process.stdout.write("0.1.0\n"));
  await program.parseAsync([...argv], { from: "user" });
  return 0;
}
```

```ts
// src/pi/extension.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function harnessExtension(pi: ExtensionAPI): void {
  pi.registerCommand("harness-doctor", {
    description: "Report whether the harness extension loaded",
    handler: async (_args, ctx) => ctx.ui.notify("Harness extension loaded", "info"),
  });
}
```

```js
#!/usr/bin/env node
const { main } = await import("../dist/cli/main.js");
process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 4: Build and smoke both entrypoints**

```bash
npm run build
node bin/harness.mjs --help
npm test -- test/integration/package-smoke.test.ts
```

Expected: all commands exit 0; the CLI and extension files both exist in `dist/`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .gitignore src bin test/integration/package-smoke.test.ts
git commit -m "chore: scaffold loadable harness package"
```

## Task 2: Define Versioned External Schemas

**Files:**
- Create: `src/contracts/common.ts`, `workflow.ts`, `task-graph.ts`, `events.ts`, `worker-result.ts`, `index.ts`
- Create: `src/shared/canonical-json.ts`, `deep-freeze.ts`, `sha256.ts`
- Test: `test/unit/contracts/schemas.test.ts`

**Interfaces:**
- Produces `WorkflowDocument`, `TaskGraphDocument`, `HarnessEvent`, and `WorkerResult` types plus Ajv-compatible schemas.
- Workflow YAML requires `schema: harness/v1`; JSON contracts require `schemaVersion: 1`; hashes match `^sha256:[0-9a-f]{64}$`.

- [ ] **Step 1: Write schema rejection tests**

```ts
import { expect, it } from "vitest";
import { validateTaskGraph, validateWorkerResult } from "../../../src/contracts/index.js";

it("rejects short semantic hashes and unknown fields", () => {
  expect(() => validateTaskGraph({ schemaVersion: 1, tasksSemanticHash: "invalid-hash", tasks: [], extra: true })).toThrow();
});

it("requires typed blockers", () => {
  expect(() => validateWorkerResult({ schemaVersion: 1, outcome: "blocked", blocker: { reason: "x" } })).toThrow();
});
```

- [ ] **Step 2: Run and observe missing validators**

Run: `npm test -- test/unit/contracts/schemas.test.ts`

Expected: FAIL with missing module exports.

- [ ] **Step 3: Define closed TypeBox schemas and compiled validators**

```ts
// src/contracts/common.ts
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import Ajv from "ajv";

export const HashSchema = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
export const VersionSchema = Type.Literal(1);
const ajv = new Ajv({ allErrors: true, strict: true });

export function validator<T extends TSchema>(schema: T): (value: unknown) => Static<T> {
  const check = ajv.compile(schema);
  return (value): Static<T> => {
    if (!check(value)) throw new Error(ajv.errorsText(check.errors));
    return value as Static<T>;
  };
}
```

```ts
// src/contracts/task-graph.ts
import { Type, type Static } from "@sinclair/typebox";
import { HashSchema, VersionSchema, validator } from "./common.js";

export const TaskNodeSchema = Type.Object({
  id: Type.String({ pattern: "^T[0-9]{3,}$" }),
  title: Type.String({ minLength: 1 }),
  dependsOn: Type.Array(Type.String()),
  acceptanceRefs: Type.Array(Type.String()),
  ownedPaths: Type.Array(Type.String()),
}, { additionalProperties: false });

export const TaskGraphSchema = Type.Object({
  schemaVersion: VersionSchema,
  tasksSemanticHash: HashSchema,
  tasks: Type.Array(TaskNodeSchema),
}, { additionalProperties: false });

export type TaskGraphDocument = Static<typeof TaskGraphSchema>;
export const validateTaskGraph = validator(TaskGraphSchema);
```

```ts
// src/contracts/events.ts
export const HarnessEventSchema = Type.Object({
  schemaVersion: VersionSchema,
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: Type.String({ format: "date-time" }),
  runId: Type.String({ minLength: 1 }),
  entityId: Type.String({ minLength: 1 }),
  eventType: Type.String({ minLength: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
  fencingToken: Type.Integer({ minimum: 1 }),
  payload: Type.Unknown(),
  prevHash: HashSchema,
  eventHash: HashSchema,
}, { additionalProperties: false });
export type HarnessEvent = Static<typeof HarnessEventSchema>;
export const validateHarnessEvent = validator(HarnessEventSchema);
```

```ts
// src/contracts/worker-result.ts
const EvidenceSchema = Type.Object({ kind: Type.String(), path: Type.String(), sha256: HashSchema }, { additionalProperties: false });
const BlockerSchema = Type.Object({ reason: Type.String(), evidence: Type.Array(Type.String()), suggestedChange: Type.String() }, { additionalProperties: false });
export const WorkerResultSchema = Type.Union([
  Type.Object({ schemaVersion: VersionSchema, assignmentHash: HashSchema, outcome: Type.Literal("completed"), commit: Type.String(), evidence: Type.Array(EvidenceSchema) }, { additionalProperties: false }),
  Type.Object({ schemaVersion: VersionSchema, assignmentHash: HashSchema, outcome: Type.Literal("blocked"), blocker: BlockerSchema }, { additionalProperties: false }),
  Type.Object({ schemaVersion: VersionSchema, assignmentHash: HashSchema, outcome: Type.Literal("failed"), reason: Type.String(), evidence: Type.Array(Type.String()) }, { additionalProperties: false }),
]);
export type WorkerResult = Static<typeof WorkerResultSchema>;
export const validateWorkerResult = validator(WorkerResultSchema);
```

```ts
// src/contracts/workflow.ts
const NeedSchema = Type.Object({
  stage: Type.String(),
  scope: Type.Union([Type.Literal("same-item"), Type.Literal("all")]),
}, { additionalProperties: false });
const RunnerSchema = Type.Union([
  Type.Literal("pi"),
  Type.Object({ prefer: Type.Array(Type.Union([Type.Literal("codex"), Type.Literal("devin"), Type.Literal("claude")]), { minItems: 1 }) }, { additionalProperties: false }),
]);
const ForeachSchema = Type.Object({ source: Type.String(), key: Type.String() }, { additionalProperties: false });
const StageSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }),
  uses: Type.String({ minLength: 1 }),
  runner: Type.Optional(RunnerSchema),
  needs: Type.Optional(Type.Array(NeedSchema)),
  model_profile: Type.Optional(Type.String()),
  foreach: Type.Optional(ForeachSchema),
  gate: Type.Optional(Type.String()),
  isolation: Type.Optional(Type.Literal("worktree")),
  profile: Type.Optional(Type.String()),
  with: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  policies: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  produces: Type.Optional(Type.Record(Type.String(), Type.String())),
  retry: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  timeout: Type.Optional(Type.Integer({ minimum: 1 })),
  on_failure: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });
const TaskModelSchema = Type.Object({
  source: Type.String(),
  complete_when: Type.Object({ stage: Type.String() }, { additionalProperties: false }),
}, { additionalProperties: false });
export const WorkflowSchema = Type.Object({
  schema: Type.Literal("harness/v1"),
  name: Type.String(),
  task_model: Type.Optional(TaskModelSchema),
  stages: Type.Array(StageSchema),
}, { additionalProperties: false });
export type WorkflowDocument = Static<typeof WorkflowSchema>;
export const validateWorkflow = validator(WorkflowSchema);
```

```ts
// src/shared/canonical-json.ts, deep-freeze.ts, sha256.ts
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("canonical JSON does not support undefined");
  return encoded;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
```

- [ ] **Step 4: Add round-trip and malformed-document cases**

```ts
expect(validateTaskGraph({ schemaVersion: 1, tasksSemanticHash: `sha256:${"a".repeat(64)}`, tasks: [] })).toBeTruthy();
expect(() => validateTaskGraph({ schemaVersion: 2, tasksSemanticHash: `sha256:${"a".repeat(64)}`, tasks: [] })).toThrow();
expect(() => validateTaskGraph({ schemaVersion: 1, tasksSemanticHash: `sha256:${"a".repeat(64)}`, tasks: [], extra: true })).toThrow();
```

Use the 64-character hash as the valid fixture. Add invalid task IDs, negative sequence/fencing values, missing evidence, and extra-key cases.

Run: `npm test -- test/unit/contracts/schemas.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts test/unit/contracts
git commit -m "feat: define versioned harness contracts"
```

## Task 3: Add Typed Test Factories

**Files:**
- Create: `test/support/factories.ts`, `fixture.ts`, `fake-clock.ts`, `fake-process.ts`, `temp-repo.ts`
- Test: `test/unit/contracts/test-support.test.ts`

**Interfaces:**
- Produces `fixtureWorkflow`, `fixtureTaskGraph`, `fixtureEvent`, `fixtureState`, `diamondTaskGraph`, and `createTempRepo`.
- Every factory returns production contract types and accepts `DeepPartial<T>` overrides.

- [ ] **Step 1: Write a compile/runtime test for every factory**

```ts
import { expect, it } from "vitest";
import { diamondTaskGraph, fixtureEvent, fixtureWorkflow } from "../../support/factories.js";

it("builds schema-valid independent fixtures", () => {
  expect(fixtureWorkflow().schemaVersion).toBe(1);
  expect(fixtureEvent().eventHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(diamondTaskGraph().tasks.map((task) => task.id)).toEqual(["T001", "T002", "T003"]);
});
```

- [ ] **Step 2: Run and observe missing factories**

Run: `npm test -- test/unit/contracts/test-support.test.ts`

Expected: FAIL with missing exports.

- [ ] **Step 3: Implement deterministic factories**

```ts
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export function fixture<T>(base: () => T): (overrides?: DeepPartial<T>) => T {
  return (overrides = {}) => deepFreeze(deepMerge(base(), overrides));
}

export function diamondTaskGraph(overrides: DeepPartial<TaskGraphDocument> = {}): TaskGraphDocument {
  const base: TaskGraphDocument = {
    schemaVersion: 1,
    tasksSemanticHash: `sha256:${"a".repeat(64)}`,
    tasks: [
      { id: "T001", title: "one", dependsOn: [], acceptanceRefs: ["AC1"], ownedPaths: ["src/one.ts"] },
      { id: "T002", title: "two", dependsOn: [], acceptanceRefs: ["AC2"], ownedPaths: ["src/two.ts"] },
      { id: "T003", title: "three", dependsOn: ["T001", "T002"], acceptanceRefs: ["AC3"], ownedPaths: ["src/three.ts"] },
    ],
  };
  return fixture(() => base)(overrides);
}
```

`FakeClock` must expose `now()`, `setTimeout()`, and `advanceBy(ms)` without real sleeping. `FakeProcessRunner` records argv/cwd/env and returns queued results. `createTempRepo()` initializes Git with explicit user identity and one commit.

- [ ] **Step 4: Typecheck and run the support test**

Run: `npm run typecheck && npm test -- test/unit/contracts/test-support.test.ts`

Expected: PASS with no `any` in `test/support/`.

- [ ] **Step 5: Commit**

```bash
git add test/support test/unit/contracts/test-support.test.ts
git commit -m "test: add typed harness factories"
```

## Task 4: Compile and Freeze Workflow Configuration

**Files:**
- Create: `src/config/load.ts`, `interpolate.ts`, `compile.ts`, `hash.ts`
- Test: `test/unit/config/compiler.test.ts`
- Fixtures: `test/fixtures/workflows/valid.yaml`, `unknown-command.yaml`, `cycle.yaml`

**Interfaces:**
- Produces `compileWorkflow(input: CompileInput): CompiledWorkflow`.
- `CompiledWorkflow` is deeply frozen and includes `revision: sha256:<64 hex>`.

- [ ] **Step 1: Write compiler tests**

```ts
it("resolves named argv commands and returns a frozen revision", () => {
  const compiled = compileWorkflow({ workflow: fixtureWorkflow(), environment: fixtureEnvironment() });
  expect(compiled.stages[0].action.input.argv).toEqual(["npm", "test"]);
  expect(compiled.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(compiled.stages)).toBe(true);
});

it("rejects unknown references and stage cycles", () => {
  expect(() => compileWorkflow(fixtureCompileInput({ command: "missing" }))).toThrow(/unknown command/);
  expect(() => compileWorkflow(fixtureCompileInput({ cycle: true }))).toThrow(/cycle/);
});
```

- [ ] **Step 2: Run and observe missing compiler**

Run: `npm test -- test/unit/config/compiler.test.ts`

Expected: FAIL with missing `compileWorkflow`.

- [ ] **Step 3: Implement normalization, interpolation, hashing, and freeze**

```ts
export function compileWorkflow(input: CompileInput): CompiledWorkflow {
  const document = validateWorkflow(structuredClone(input.workflow));
  const stages = topologicalStages(document.stages).map((stage) => ({
    ...stage,
    action: { kind: stage.uses, input: resolveReferences(stage.with ?? {}, input.environment.commands) },
  }));
  const normalized = { schemaVersion: 1 as const, name: document.name, taskModel: document.task_model, stages };
  const revision = sha256(canonicalJson(normalized));
  return deepFreeze({ ...normalized, revision });
}
```

Interpolation accepts only complete scalar references like `${commands.task_verify}` and expands them to stored argv arrays. Reject shell strings, environment recursion, missing names, duplicate stage IDs, unknown dependencies, cycles, `same-item` without matching `foreach`, incompatible fan-out definitions, and mutation after compilation.

- [ ] **Step 4: Add property tests for deterministic hashing**

```ts
fc.assert(fc.property(workflowKeyOrderArbitrary(), (pair) => {
  expect(compileWorkflow(pair.left).revision).toBe(compileWorkflow(pair.right).revision);
}));
expect(compileWorkflow(input).revision).not.toBe(compileWorkflow(withChangedArgv(input)).revision);
```

Run: `npm test -- test/unit/config/compiler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config test/unit/config test/fixtures/workflows
git commit -m "feat: compile immutable workflow revisions"
```

## Task 5: Validate the Spec Kit Task Graph

**Files:**
- Create: `src/core/task-graph.ts`, `src/core/path-conflicts.ts`
- Test: `test/unit/graph/validation.test.ts`

**Interfaces:**
- Produces `validateGraph(graph, context): ValidatedTaskGraph`.
- `context` supplies accepted task IDs, acceptance references, and computed `tasks.md` semantic hash.

- [ ] **Step 1: Write graph failure cases**

```ts
it.each([
  ["duplicate", fixtureTaskGraph({ duplicate: true }), /duplicate task/],
  ["unknown dependency", fixtureTaskGraph({ unknownDependency: true }), /unknown dependency/],
  ["cycle", fixtureTaskGraph({ cycle: true }), /cycle/],
  ["stale hash", fixtureTaskGraph(), /semantic hash/],
  ["parallel overlap", fixtureTaskGraph({ unorderedOverlap: true }), /owned path conflict/],
])("rejects %s", (_name, graph, error) => {
  expect(() => validateGraph(graph, fixtureGraphContext({ tasksSemanticHash: `sha256:${"b".repeat(64)}` }))).toThrow(error);
});
```

- [ ] **Step 2: Run and observe missing validator**

Run: `npm test -- test/unit/graph/validation.test.ts`

Expected: FAIL with missing `validateGraph`.

- [ ] **Step 3: Implement deterministic validation**

```ts
export function validateGraph(graph: TaskGraphDocument, context: GraphContext): ValidatedTaskGraph {
  if (graph.tasksSemanticHash !== context.tasksSemanticHash) throw new GraphError("stale semantic hash");
  const byId = uniqueMap(graph.tasks, (task) => task.id, "duplicate task");
  for (const task of graph.tasks) {
    for (const dep of task.dependsOn) if (!byId.has(dep)) throw new GraphError(`unknown dependency ${dep}`);
    for (const ref of task.acceptanceRefs) if (!context.acceptanceRefs.has(ref)) throw new GraphError(`unknown acceptance reference ${ref}`);
  }
  const order = topologicalOrder(byId);
  rejectUnorderedPathOverlap(byId, order);
  return deepFreeze({ graph, byId, order });
}
```

File overlap is allowed only when reachability orders the two owners. Normalize paths relative to the repository root and reject absolute paths, `..`, empty globs, and protected planning/config paths.

- [ ] **Step 4: Add valid diamond and ordered-overlap cases**

```ts
expect(validateGraph(diamondTaskGraph(), fixtureGraphContext()).order.at(-1)).toBe("T003");
expect(() => validateGraph(fixtureTaskGraph({ orderedOverlap: true }), fixtureGraphContext())).not.toThrow();
```

Run: `npm test -- test/unit/graph/validation.test.ts`

Expected: PASS; the diamond order starts with T001/T002 and ends with T003.

- [ ] **Step 5: Commit**

```bash
git add src/core/task-graph.ts src/core/path-conflicts.ts test/unit/graph/validation.test.ts
git commit -m "feat: validate Spec Kit task graphs"
```

## Task 6: Materialize Fan-Out Jobs and Joins

**Files:**
- Create: `src/core/materialize.ts`, `src/core/job-id.ts`
- Test: `test/unit/graph/materialize.test.ts`

**Interfaces:**
- Produces `materializeJobs(workflow, graph): MaterializedRunGraph`.
- Job IDs are `${stageId}:${key}` for keyed stages and `${stageId}` for singleton stages.

- [ ] **Step 1: Write diamond/fan-in tests**

```ts
it("materializes same-item joins and an all barrier", () => {
  const result = materializeJobs(fixtureWorkflow(), validateDiamond());
  expect(result.jobs["review:T001"].dependsOn).toEqual(["implement:T001"]);
  expect(result.jobs["integrate:T003"].dependsOn).toEqual(["verify:T003"]);
  expect(result.jobs.final_verify.dependsOn).toEqual(["integrate:T001", "integrate:T002", "integrate:T003"]);
});

it("rejects duplicate dynamic keys", () => {
  expect(() => materializeJobs(fixtureWorkflow(), validatedGraphWithDuplicateProjection())).toThrow(/duplicate key/);
});
```

- [ ] **Step 2: Run and observe missing materializer**

Run: `npm test -- test/unit/graph/materialize.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement stable projection**

```ts
export function materializeJobs(workflow: CompiledWorkflow, graph: ValidatedTaskGraph): MaterializedRunGraph {
  const jobs = new Map<string, MaterializedJob>();
  for (const stage of workflow.stages) {
    const keys = stage.foreach ? graph.order : [undefined];
    for (const key of keys) {
      const id = key ? `${stage.id}:${key}` : stage.id;
      if (jobs.has(id)) throw new MaterializationError(`duplicate key ${id}`);
      jobs.set(id, { id, stageId: stage.id, taskId: key, dependsOn: resolveJobDependencies(stage, key, jobs, graph) });
    }
  }
  return deepFreeze({ jobs: Object.fromEntries(jobs), taskProjection: buildTaskProjection(jobs) });
}
```

`same-item` requires an identical key. `all` expands to every upstream key. A keyed stage cannot depend on a singleton through `same-item`. Reject empty barriers and ambiguous mixed joins.

- [ ] **Step 4: Run the phase gate**

Run: `npm run check:phase1`

Expected: PASS, including the package smoke and all deterministic-core tests.

- [ ] **Step 5: Commit and stop for milestone review**

```bash
git add src/core/materialize.ts src/core/job-id.ts test/unit/graph/materialize.test.ts package.json package-lock.json
git commit -m "feat: materialize deterministic workflow jobs"
```
