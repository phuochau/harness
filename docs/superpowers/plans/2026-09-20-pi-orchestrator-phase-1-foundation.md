# Pi Orchestrator Phase 1: Package and Deterministic Contracts Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Produce a loadable package and deterministic workflow/task-graph core with exact schemas and typed fixtures.

**Architecture:** This phase contains no external side effects. TypeBox owns wire formats, the compiler freezes a normalized workflow, and graph materialization produces stable job IDs consumed by all later phases.

**Tech Stack:** Node.js 22+, TypeScript ESM, `@earendil-works/pi-coding-agent@0.86.1`, `typebox@1.3.34`, Ajv with `ajv-formats`, YAML, Vitest, fast-check.

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
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { expect, it } from "vitest";

it("builds a runnable CLI and importable extension", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.name).toBe("pi-multi-agent-harness");
  expect(pkg.pi.extensions).toEqual(["./dist/pi/extension.js"]);
  const result = await execa(process.execPath, ["bin/harness.mjs", "--help"], { cwd: process.cwd() });
  expect(result.stdout).toContain("harness");
  await expect(access(resolve("dist/pi/extension.js"))).resolves.toBeUndefined();
  await expect(import(pathToFileURL(resolve("dist/pi/extension.js")).href)).resolves.toHaveProperty("default");
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
    "check:phase1": "npm run typecheck && npm run build && vitest run test/unit/contracts test/unit/config test/unit/graph test/integration/package-smoke.test.ts"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

Run:

```bash
npm install --save-exact ajv ajv-formats commander execa proper-lockfile yaml
npm install --save-dev --save-exact @earendil-works/pi-coding-agent@0.86.1 typebox@1.3.34 @types/node @types/proper-lockfile fast-check typescript vitest
```

Pi-bundled packages remain `"*"` peers as required by Pi package loading; the
development lockfile and release compatibility manifest pin the exact tested
host versions shown above.

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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
- Create: `src/contracts/common.ts`, `controller-command.ts`, `workflow.ts`, `environment.ts`, `lock.ts`, `task-graph.ts`, `events.ts`, `worker-result.ts`, `index.ts`
- Create: `src/shared/canonical-json.ts`, `deep-freeze.ts`, `sha256.ts`
- Test: `test/unit/contracts/schemas.test.ts`

**Interfaces:**
- Produces `ControllerCommand`, `WorkflowDocument`, `EnvironmentDocument`, `HarnessLock`, `TaskGraphDocument`, `HarnessEvent`, and `WorkerResult` types plus Ajv-compatible schemas.
- Workflow YAML requires `schema: harness/v1`; environment YAML requires `schema: harness/environment/v1`; the lock requires `schema: harness/lock/v1`; the task graph requires `schema: harness/task-graph/v1`; other JSON contracts require `schemaVersion: 1`; hashes match `^sha256:[0-9a-f]{64}$`.

- [ ] **Step 1: Write schema rejection tests**

```ts
import { expect, it } from "vitest";
import { validateControllerCommand, validateEnvironmentAndLock, validateTaskGraph, validateWorkerResult } from "../../../src/contracts/index.js";
import { canonicalJson } from "../../../src/shared/canonical-json.js";

it("rejects short semantic hashes and unknown fields", () => {
  expect(() => validateTaskGraph({ schema: "harness/task-graph/v1", tasksSemanticHash: "invalid-hash", tasks: [], extra: true })).toThrow();
});

it("requires typed blockers", () => {
  expect(() => validateWorkerResult({ schemaVersion: 1, outcome: "blocked", blocker: { reason: "x" } })).toThrow();
});

it("rejects non-JSON durable command payloads", () => {
  expect(() => validateControllerCommand({ schemaVersion: 1, source: "operator", kind: "operator_intent", idempotencyKey: "retry:T001", payload: { callback: () => undefined } })).toThrow();
});

it("canonicalizes object keys by locale-independent code-unit order", () => {
  expect(canonicalJson({ "ä": 3, z: 2, A: 1 })).toBe('{"A":1,"z":2,"ä":3}');
});

it("rejects Pi package requirements that are not exact lock projections", () => {
  expect(() => validateEnvironmentAndLock(
    { schema: "harness/environment/v1", commands: {}, pi_packages: [{ id: "harness", dependency: "missing", scope: "project", resources: { extensions: ["dist/pi/extension.js"] } }] },
    { schema: "harness/lock/v1", harnessVersion: "0.1.0", dependencies: [] },
  )).toThrow(/lock dependency/);
});
```

- [ ] **Step 2: Run and observe missing validators**

Run: `npm test -- test/unit/contracts/schemas.test.ts`

Expected: FAIL with missing module exports.

- [ ] **Step 3: Define closed TypeBox schemas and compiled validators**

```ts
// src/contracts/common.ts
import { Type, type Static, type TSchema } from "typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";

export const HashSchema = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
export const VersionSchema = Type.Literal(1);
export const JsonValueSchema = Type.Recursive((Self) => Type.Union([
  Type.Null(), Type.Boolean(), Type.Number(), Type.String(),
  Type.Array(Self), Type.Record(Type.String(), Self),
]));
export type JsonValue = Static<typeof JsonValueSchema>;
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

export function validator<T extends TSchema>(schema: T): (value: unknown) => Static<T> {
  const check = ajv.compile(schema);
  return (value): Static<T> => {
    if (!check(value)) throw new Error(ajv.errorsText(check.errors));
    return value as Static<T>;
  };
}
```

```ts
// src/contracts/controller-command.ts
import { Type, type Static } from "typebox";
import { JsonValueSchema, VersionSchema, validator } from "./common.js";

export const ControllerCommandSchema = Type.Object({
  schemaVersion: VersionSchema,
  source: Type.Union([
    Type.Literal("timer"), Type.Literal("herdr"), Type.Literal("pi"),
    Type.Literal("operator"), Type.Literal("recovery"),
  ]),
  kind: Type.Union([
    Type.Literal("tick"), Type.Literal("runtime_event"),
    Type.Literal("operator_intent"), Type.Literal("planning_turn"),
    Type.Literal("recover"),
  ]),
  idempotencyKey: Type.String({ minLength: 1 }),
  payload: JsonValueSchema,
}, { additionalProperties: false });

export type ControllerCommand = Static<typeof ControllerCommandSchema>;
export const validateControllerCommand = validator(ControllerCommandSchema);
```

```ts
// src/contracts/environment.ts and lock.ts
const PackagePathSchema = Type.String({ minLength: 1 });
const PiResourcesSchema = Type.Object({
  extensions: Type.Optional(Type.Array(PackagePathSchema, { minItems: 1 })),
  skills: Type.Optional(Type.Array(PackagePathSchema, { minItems: 1 })),
  prompts: Type.Optional(Type.Array(PackagePathSchema, { minItems: 1 })),
  themes: Type.Optional(Type.Array(PackagePathSchema, { minItems: 1 })),
}, { additionalProperties: false });
const PiPackageRequirementSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  dependency: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  scope: Type.Literal("project"),
  resources: PiResourcesSchema,
}, { additionalProperties: false });
export const EnvironmentSchema = Type.Object({
  schema: Type.Literal("harness/environment/v1"),
  commands: Type.Record(Type.String({ pattern: "^[a-z][a-z0-9_]*$" }), Type.Array(Type.String(), { minItems: 1 })),
  pi_packages: Type.Array(PiPackageRequirementSchema, { minItems: 1 }),
}, { additionalProperties: false });
export type EnvironmentDocument = Static<typeof EnvironmentSchema>;

const LockedSourceSchema = Type.Object({
  kind: Type.Union([Type.Literal("npm"), Type.Literal("git"), Type.Literal("formula"), Type.Literal("signed-artifact"), Type.Literal("manual")]),
  identity: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  integrity: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const LockedDependencySchema = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  kind: Type.Union([Type.Literal("pi-package"), Type.Literal("tool"), Type.Literal("integration"), Type.Literal("manual")]),
  version: Type.String({ minLength: 1 }),
  source: LockedSourceSchema,
  piSource: Type.Optional(Type.String({ minLength: 1 })),
  dependsOn: Type.Array(Type.String()),
}, { additionalProperties: false });
export const HarnessLockSchema = Type.Object({
  schema: Type.Literal("harness/lock/v1"),
  harnessVersion: Type.String({ minLength: 1 }),
  dependencies: Type.Array(LockedDependencySchema),
}, { additionalProperties: false });
export type HarnessLock = Static<typeof HarnessLockSchema>;
```

`validateEnvironmentAndLock` adds the semantic checks that JSON Schema cannot
express compactly: IDs and arrays are unique; each resource set is nonempty;
package paths are normalized relative paths with no glob, traversal, or NUL;
each `dependency` exists exactly once with `kind: pi-package`;
and that dependency has an exact pinned npm-version or Git-commit `piSource`
whose identity/version agree with its trusted source and integrity. Local paths
and floating Git refs are never automatic. Filesystem probes separately reject
resource or cache symlink escapes. The validator returns the typed pair used by
the compiler, init, bootstrap, and doctor.

```ts
// src/contracts/task-graph.ts
import { Type, type Static } from "typebox";
import { HashSchema, validator } from "./common.js";

export const TaskNodeSchema = Type.Object({
  id: Type.String({ pattern: "^T[0-9]{3,}$" }),
  description: Type.String({ minLength: 1 }),
  phase: Type.String({ minLength: 1 }),
  labels: Type.Array(Type.String()),
  parallelEligible: Type.Boolean(),
  dependsOn: Type.Array(Type.String()),
  acceptanceRefs: Type.Array(Type.String({ pattern: "^(FR|SC)-[0-9]{3}$" })),
  ownedPaths: Type.Array(Type.String()),
}, { additionalProperties: false });

export const TaskGraphSchema = Type.Object({
  schema: Type.Literal("harness/task-graph/v1"),
  tasksSemanticHash: HashSchema,
  tasks: Type.Array(TaskNodeSchema),
}, { additionalProperties: false });

export type TaskGraphDocument = Static<typeof TaskGraphSchema>;
export const validateTaskGraph = validator(TaskGraphSchema);
```

```ts
// src/contracts/events.ts
import { Type, type Static, type TSchema } from "typebox";
import { HashSchema, JsonValueSchema, VersionSchema, validator } from "./common.js";
import { ControllerCommandSchema } from "./controller-command.js";
import { WorkerResultSchema } from "./worker-result.js";

const EventEnvelopeProperties = {
  schemaVersion: VersionSchema,
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: Type.String({ format: "date-time" }),
  runId: Type.String({ minLength: 1 }),
  entityId: Type.String({ minLength: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
  fencingToken: Type.Integer({ minimum: 1 }),
  prevHash: HashSchema,
  eventHash: HashSchema,
};

function event<T extends string, P extends TSchema>(eventType: T, payload: P) {
  return Type.Object({ ...EventEnvelopeProperties, eventType: Type.Literal(eventType), payload }, { additionalProperties: false });
}

const RecoveryClassSchema = Type.Union([Type.Literal("idempotent"), Type.Literal("reconcilable"), Type.Literal("non_retryable")]);
const BlockerSchema = Type.Object({ reason: Type.String(), evidence: Type.Array(Type.String()), suggestedChange: Type.String() }, { additionalProperties: false });
const EffectIntentPayloadSchema = Type.Object({ action: Type.String(), idempotencyKey: Type.String(), recovery: RecoveryClassSchema, laneKey: Type.String(), input: JsonValueSchema }, { additionalProperties: false });
const EffectObservationPayloadSchema = Type.Object({ action: Type.String(), intentKey: Type.String(), output: JsonValueSchema }, { additionalProperties: false });
const EffectFailurePayloadSchema = Type.Object({ action: Type.String(), intentKey: Type.String(), code: Type.String(), evidence: Type.Array(Type.String()) }, { additionalProperties: false });
export const DecisionEventDraftSchema = Type.Object({ eventType: Type.String({ minLength: 1 }), entityId: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }), payload: JsonValueSchema }, { additionalProperties: false });
export const CommandDecisionBatchSchema = Type.Object({
  commandKey: Type.String({ minLength: 1 }),
  acceptedSequence: Type.Integer({ minimum: 1 }),
  acceptedAt: Type.String({ format: "date-time" }),
  stateRevision: Type.Integer({ minimum: 1 }),
  decisionHash: HashSchema,
  events: Type.Array(DecisionEventDraftSchema),
  effects: Type.Array(EffectIntentPayloadSchema),
}, { additionalProperties: false });
export type DecisionEventDraft = Static<typeof DecisionEventDraftSchema>;
export type CommandDecisionBatch = Static<typeof CommandDecisionBatchSchema>;
const OperatorIntentPayloadSchema = Type.Object({ operation: Type.Union([Type.Literal("retry"), Type.Literal("reroute"), Type.Literal("cancel"), Type.Literal("pause"), Type.Literal("resume")]), target: Type.String(), arguments: Type.Record(Type.String(), JsonValueSchema) }, { additionalProperties: false });
const PlanningStageSchema = Type.Union([Type.Literal("specify"), Type.Literal("plan"), Type.Literal("tasks")]);
const PlanningMarkerPayloadSchema = Type.Object({ stage: PlanningStageSchema, sessionFile: Type.String(), correlationId: Type.String(), requestEntryId: Type.String(), command: Type.String() }, { additionalProperties: false });
const PlanningSettledPayloadSchema = Type.Object({ correlationId: Type.String(), finalTurnIndex: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const PlanningRecoveredPayloadSchema = Type.Object({ correlationId: Type.String(), finalTurnIndex: Type.Integer({ minimum: 0 }), terminalEntryId: Type.String(), terminalEntryHash: HashSchema }, { additionalProperties: false });
const PlanningCompletedPayloadSchema = Type.Union([
  Type.Object({ stage: Type.Union([Type.Literal("specify"), Type.Literal("plan")]), correlationId: Type.String(), hashes: Type.Record(Type.String(), HashSchema) }, { additionalProperties: false }),
  Type.Object({ stage: Type.Literal("tasks"), correlationId: Type.String(), commit: Type.String({ minLength: 1 }), hashes: Type.Record(Type.String(), HashSchema) }, { additionalProperties: false }),
]);

export const HarnessEventSchema = Type.Union([
  event("run.created", Type.Object({ workflowRevision: HashSchema }, { additionalProperties: false })),
  event("controller.command_received", Type.Object({ command: ControllerCommandSchema }, { additionalProperties: false })),
  event("controller.command_decided", CommandDecisionBatchSchema),
  event("controller.command_processed", Type.Object({ source: Type.String(), commandKey: Type.String() }, { additionalProperties: false })),
  event("job.ready", Type.Object({}, { additionalProperties: false })),
  event("attempt.started", Type.Object({ attempt: Type.Integer({ minimum: 1 }), worker: Type.String() }, { additionalProperties: false })),
  event("worker.routed", Type.Object({ worker: Type.String(), reason: Type.String() }, { additionalProperties: false })),
  event("worker.result_observed", WorkerResultSchema),
  event("review.approved", Type.Object({ commit: Type.String(), reviewer: Type.String() }, { additionalProperties: false })),
  event("review.changes_requested", Type.Object({ commit: Type.String(), reviewer: Type.String(), findings: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false })),
  event("verification.passed", Type.Object({ commit: Type.String(), evidence: Type.Array(Type.String()) }, { additionalProperties: false })),
  event("verification.failed", Type.Object({ commit: Type.String(), evidence: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false })),
  event("integration.observed", Type.Object({ candidateCommit: Type.String(), candidateRef: Type.String(), expectedRunHead: Type.String(), patchId: Type.String() }, { additionalProperties: false })),
  event("integration.conflicted", Type.Object({ sourceBase: Type.String(), sourceHead: Type.String(), patchId: Type.String(), evidence: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false })),
  event("task.finalized", Type.Object({ taskId: Type.String(), candidateCommit: Type.String(), targetCommit: Type.String(), tasksSemanticHash: HashSchema }, { additionalProperties: false })),
  event("effect.intent", EffectIntentPayloadSchema),
  event("effect.observed", EffectObservationPayloadSchema),
  event("effect.failed", EffectFailurePayloadSchema),
  event("operator.intent", OperatorIntentPayloadSchema),
  event("planning.queued", PlanningMarkerPayloadSchema),
  event("planning.agent_settled", PlanningSettledPayloadSchema),
  event("planning.transcript_recovered", PlanningRecoveredPayloadSchema),
  event("planning.completed", PlanningCompletedPayloadSchema),
  event("planning.blocked", BlockerSchema),
  event("job.done", Type.Object({}, { additionalProperties: false })),
  event("job.invalidated", Type.Object({ supersededGeneration: Type.Integer({ minimum: 1 }), reason: Type.String() }, { additionalProperties: false })),
  event("job.blocked", BlockerSchema),
  event("job.failed", Type.Object({ reason: Type.String() }, { additionalProperties: false })),
]);
export type HarnessEvent = Static<typeof HarnessEventSchema>;
export const validateHarnessEvent = validator(HarnessEventSchema);
```

```ts
// src/contracts/worker-result.ts
const EvidenceSchema = Type.Object({ kind: Type.String(), path: Type.String(), sha256: HashSchema }, { additionalProperties: false });
const BlockerSchema = Type.Object({ reason: Type.String(), evidence: Type.Array(Type.String()), suggestedChange: Type.String() }, { additionalProperties: false });
export const WorkerResultSchema = Type.Union([
  Type.Object({ schemaVersion: VersionSchema, assignmentHash: HashSchema, role: Type.Literal("implementation"), outcome: Type.Literal("completed"), commit: Type.String(), evidence: Type.Array(EvidenceSchema) }, { additionalProperties: false }),
  Type.Object({ schemaVersion: VersionSchema, assignmentHash: HashSchema, role: Type.Literal("review"), outcome: Type.Literal("approved"), reviewedCommit: Type.String(), findings: Type.Array(Type.String()), evidence: Type.Array(EvidenceSchema) }, { additionalProperties: false }),
  Type.Object({ schemaVersion: VersionSchema, assignmentHash: HashSchema, role: Type.Literal("review"), outcome: Type.Literal("changes_requested"), reviewedCommit: Type.String(), findings: Type.Array(Type.String(), { minItems: 1 }), evidence: Type.Array(EvidenceSchema) }, { additionalProperties: false }),
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
const RetryStageSchema = Type.Object({ retry_stage: Type.String() }, { additionalProperties: false });
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
  if: Type.Optional(Type.Object({ expression: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  with: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  policies: Type.Optional(Type.Object({
    require_different_worker_kind: Type.Optional(Type.Boolean()),
    scope: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("final_diff")])),
  }, { additionalProperties: false })),
  produces: Type.Optional(Type.Record(Type.String(), Type.String())),
  retry: Type.Optional(Type.Object({ max_attempts: Type.Integer({ minimum: 1 }), max_elapsed_seconds: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
  timeout: Type.Optional(Type.Integer({ minimum: 1 })),
  on_failure: Type.Optional(Type.Object({
    changes_requested: Type.Optional(Type.Union([
      RetryStageSchema,
      Type.Object({ block: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ])),
    verification_failed: Type.Optional(RetryStageSchema),
  }, { additionalProperties: false })),
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
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
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
expect(validateTaskGraph({ schema: "harness/task-graph/v1", tasksSemanticHash: `sha256:${"a".repeat(64)}`, tasks: [] })).toBeTruthy();
expect(() => validateTaskGraph({ schema: "harness/task-graph/v2", tasksSemanticHash: `sha256:${"a".repeat(64)}`, tasks: [] })).toThrow();
expect(() => validateTaskGraph({ schema: "harness/task-graph/v1", tasksSemanticHash: `sha256:${"a".repeat(64)}`, tasks: [], extra: true })).toThrow();
```

Use the 64-character hash as the valid fixture. Add invalid task IDs, invalid
RFC 3339 timestamps, negative sequence/fencing values, malformed
action-specific payloads, missing evidence, and extra-key cases.

Run: `npm test -- test/unit/contracts/schemas.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts src/shared test/unit/contracts
git commit -m "feat: define versioned harness contracts"
```

## Task 3: Add Typed Test Factories

**Files:**
- Create: `test/support/factories.ts`, `fixture.ts`, `fake-clock.ts`, `fake-process.ts`, `temp-repo.ts`
- Test: `test/unit/contracts/test-support.test.ts`

**Interfaces:**
- Produces `fixtureWorkflow`, `fixtureEnvironment`, `fixtureHarnessLock`, `fixtureTaskGraph`, `fixtureEvent`, `fixtureState`, `diamondTaskGraph`, and `createTempRepo`.
- Every factory returns production contract types and accepts `DeepPartial<T>` overrides.
- Named invalid/semantic scenarios are not fake `DeepPartial<T>` keys; Tasks 4
  and 5 add separate typed `compileInputCase(kind)` and `taskGraphCase(kind)`
  builders.

- [ ] **Step 1: Write a compile/runtime test for every factory**

```ts
import { expect, it } from "vitest";
import { diamondTaskGraph, fixtureEvent, fixtureWorkflow } from "../../support/factories.js";

it("builds schema-valid independent fixtures", () => {
  expect(fixtureWorkflow().schema).toBe("harness/v1");
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

export function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  if (Array.isArray(base) || Array.isArray(overrides)) return structuredClone(overrides ?? base) as T;
  if (!base || typeof base !== "object" || !overrides || typeof overrides !== "object") return structuredClone(overrides ?? base) as T;
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = deepMerge(result[key], value);
  }
  return result as T;
}

export function fixture<T>(base: () => T): (overrides?: DeepPartial<T>) => T {
  return (overrides = {}) => deepFreeze(deepMerge(base(), overrides));
}

export function diamondTaskGraph(overrides: DeepPartial<TaskGraphDocument> = {}): TaskGraphDocument {
  const base: TaskGraphDocument = {
    schema: "harness/task-graph/v1",
    tasksSemanticHash: `sha256:${"a".repeat(64)}`,
    tasks: [
      { id: "T001", description: "one", phase: "foundation", labels: ["US1"], parallelEligible: true, dependsOn: [], acceptanceRefs: ["FR-001"], ownedPaths: ["src/one.ts"] },
      { id: "T002", description: "two", phase: "foundation", labels: ["US1"], parallelEligible: true, dependsOn: [], acceptanceRefs: ["FR-002"], ownedPaths: ["src/two.ts"] },
      { id: "T003", description: "three", phase: "integration", labels: ["US1"], parallelEligible: false, dependsOn: ["T001", "T002"], acceptanceRefs: ["SC-001"], ownedPaths: ["src/three.ts"] },
    ],
  };
  return fixture(() => base)(overrides);
}
```

`FakeClock` must expose `now()`, `setTimeout()`, and `advanceBy(ms)` without real
sleeping. `FakeProcessRunner` records argv/cwd/env/stdin and implements both
text `run()` and byte-preserving `runBytes()` queued results. `createTempRepo()`
initializes Git with explicit user identity and one commit.

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
- Create: `src/config/load.ts`, `interpolate.ts`, `compile.ts`, `hash.ts`, `action-inputs.ts`
- Test: `test/unit/config/compiler.test.ts`
- Fixtures: `test/fixtures/workflows/valid.yaml`, `unknown-command.yaml`, `cycle.yaml`

**Interfaces:**
- Produces `compileWorkflow(input: CompileInput): CompiledWorkflow`.
- Produces `compileInputCase(kind): CompileInput` for named invalid compiler scenarios without adding non-contract keys to `DeepPartial<CompileInput>`.
- `CompiledWorkflow` is deeply frozen and includes `revision: sha256:<64 hex>`.
- `CompileInput.actionSchemas` defaults to the closed built-in schemas and may add schemas from installed, policy-approved action plugins; the built-ins include `command.run: { argv, cwd?, env?, probe? }`.

- [ ] **Step 1: Write compiler tests**

```ts
it("resolves named argv commands and returns a frozen revision", () => {
  const compiled = compileWorkflow({ workflow: fixtureWorkflow(), environment: fixtureEnvironment() });
  expect(compiled.stages[0].action.input.argv).toEqual(["npm", "test"]);
  expect(compiled.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(compiled.stages)).toBe(true);
});

it("rejects unknown references and stage cycles", () => {
  expect(() => compileWorkflow(compileInputCase("unknown_command"))).toThrow(/unknown command/);
  expect(() => compileWorkflow(compileInputCase("cycle"))).toThrow(/cycle/);
});
```

- [ ] **Step 2: Run and observe missing compiler**

Run: `npm test -- test/unit/config/compiler.test.ts`

Expected: FAIL with missing `compileWorkflow`.

- [ ] **Step 3: Implement normalization, interpolation, hashing, and freeze**

```ts
export function compileInputCase(kind: "unknown_command" | "cycle"): CompileInput {
  const input = structuredClone(fixtureCompileInput());
  if (kind === "unknown_command") input.workflow.stages[0].with = { argv: "${commands.missing}" };
  else input.workflow.stages[1].needs = [{ stage: input.workflow.stages[1].id, scope: "all" }];
  return deepFreeze(input);
}

export function compileWorkflow(input: CompileInput): CompiledWorkflow {
  const document = validateWorkflow(structuredClone(input.workflow));
  const stages = topologicalStages(document.stages).map((stage) => ({
    ...stage,
    action: {
      kind: stage.uses,
      input: validateActionInput(stage.uses, resolveReferences(stage.with ?? {}, input.environment.commands)),
    },
  }));
  const normalized = { schemaVersion: 1 as const, name: document.name, taskModel: document.task_model, stages };
  const revision = sha256(canonicalJson(normalized));
  return deepFreeze({ ...normalized, revision });
}
```

```ts
// src/config/action-inputs.ts
export const BuiltInActionInputSchemas = {
  "command.run": Type.Object({
    argv: Type.Array(Type.String(), { minItems: 1 }),
    cwd: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    probe: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  }, { additionalProperties: false }),
  "human.approval": Type.Object({}, { additionalProperties: false }),
  "spec-kit.specify": Type.Object({}, { additionalProperties: false }),
  "spec-kit.plan": Type.Object({}, { additionalProperties: false }),
  "spec-kit.tasks": Type.Object({}, { additionalProperties: false }),
  "worker.execute": Type.Object({}, { additionalProperties: false }),
  "worker.review": Type.Object({}, { additionalProperties: false }),
  "git.verify": Type.Object({}, { additionalProperties: false }),
  "git.integrate": Type.Object({}, { additionalProperties: false }),
  "git.project-task-status": Type.Object({}, { additionalProperties: false }),
  "git.push": Type.Object({}, { additionalProperties: false }),
  "github.pull-request": Type.Object({}, { additionalProperties: false }),
} as const;
```

Interpolation accepts only complete scalar references like `${commands.task_verify}` and expands them to stored argv arrays. `validateActionInput` selects a closed schema by `uses`; for example `command.run` requires `{ argv: readonly string[] }`. Reject unknown action kinds, action-specific extra keys, shell strings, environment recursion, missing names, duplicate stage IDs, unknown dependencies, cycles, `same-item` without matching `foreach`, incompatible fan-out definitions, and mutation after compilation.

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
- Modify: `test/support/factories.ts`
- Test: `test/unit/graph/validation.test.ts`

**Interfaces:**
- Produces `validateGraph(graph, context): ValidatedTaskGraph`.
- Produces `taskGraphCase(kind): TaskGraphDocument` for explicitly named semantic-invalid test cases without weakening production fixture types.
- `context` supplies canonical task records parsed from `tasks.md`, accepted acceptance references, and the controller-computed semantic hash.

- [ ] **Step 1: Write graph failure cases**

```ts
it.each([
  ["duplicate", taskGraphCase("duplicate"), fixtureGraphContext(), /duplicate task/],
  ["unknown dependency", taskGraphCase("unknown_dependency"), fixtureGraphContextFor(taskGraphCase("unknown_dependency")), /unknown dependency/],
  ["cycle", taskGraphCase("cycle"), fixtureGraphContextFor(taskGraphCase("cycle")), /cycle/],
  ["stale hash", fixtureTaskGraph(), fixtureGraphContext({ tasksSemanticHash: `sha256:${"b".repeat(64)}` }), /semantic hash/],
  ["projection mismatch", taskGraphCase("changed_owned_path"), fixtureGraphContext(), /does not match tasks.md/],
  ["parallel overlap", taskGraphCase("unordered_overlap"), fixtureGraphContextFor(taskGraphCase("unordered_overlap")), /owned path conflict/],
])("rejects %s", (_name, graph, context, error) => {
  expect(() => validateGraph(graph, context)).toThrow(error);
});
```

- [ ] **Step 2: Run and observe missing validator**

Run: `npm test -- test/unit/graph/validation.test.ts`

Expected: FAIL with missing `validateGraph`.

- [ ] **Step 3: Implement deterministic validation**

```ts
export type TaskGraphCase =
  | "duplicate"
  | "unknown_dependency"
  | "cycle"
  | "changed_owned_path"
  | "unordered_overlap"
  | "ordered_overlap";

export function taskGraphCase(kind: TaskGraphCase): TaskGraphDocument {
  const graph = structuredClone(fixtureTaskGraph());
  switch (kind) {
    case "duplicate": graph.tasks.push(structuredClone(graph.tasks[0])); break;
    case "unknown_dependency": graph.tasks[2].dependsOn = ["T999"]; break;
    case "cycle": graph.tasks[0].dependsOn = ["T003"]; break;
    case "changed_owned_path": graph.tasks[0].ownedPaths = ["src/not-in-tasks.ts"]; break;
    case "unordered_overlap": graph.tasks[1].ownedPaths = [...graph.tasks[0].ownedPaths]; break;
    case "ordered_overlap": graph.tasks[2].ownedPaths = [...graph.tasks[0].ownedPaths]; break;
    default: assertNever(kind);
  }
  return deepFreeze(graph);
}

export function fixtureGraphContextFor(graph: TaskGraphDocument): GraphContext {
  return fixtureGraphContext({
    tasksSemanticHash: graph.tasksSemanticHash,
    taskRecords: new Map(graph.tasks.map((task) => [task.id, structuredClone(task)])),
  });
}

export function validateGraph(graph: TaskGraphDocument, context: GraphContext): ValidatedTaskGraph {
  if (graph.tasksSemanticHash !== context.tasksSemanticHash) throw new GraphError("stale semantic hash");
  const byId = uniqueMap(graph.tasks, (task) => task.id, "duplicate task");
  assertExactTaskSet(byId, context.taskRecords);
  for (const task of graph.tasks) {
    assertCanonicalProjection(task, context.taskRecords.get(task.id));
    for (const dep of task.dependsOn) if (!byId.has(dep)) throw new GraphError(`unknown dependency ${dep}`);
    for (const ref of task.acceptanceRefs) if (!context.acceptanceRefs.has(ref)) throw new GraphError(`unknown acceptance reference ${ref}`);
  }
  const order = topologicalOrder(byId);
  const reachability = computeReachability(byId);
  rejectUnorderedPathOverlap(byId, reachability);
  return deepFreeze({ graph, byId, order, reachability });
}
```

`assertCanonicalProjection` compares `description`, `phase`, normalized
`labels`, `parallelEligible`, `dependsOn`, `acceptanceRefs`, and normalized
`ownedPaths` with the parsed `tasks.md` record. The graph must contain exactly
the parsed task ID set. A topological list is used only for stable scheduling;
it is never evidence that two nodes are causally ordered. File overlap is
allowed only when transitive DAG reachability orders the two owners. Normalize
paths relative to the repository root and reject absolute paths, `..`, empty
globs, and protected planning/config paths.

- [ ] **Step 4: Add valid diamond and ordered-overlap cases**

```ts
expect(validateGraph(diamondTaskGraph(), fixtureGraphContext()).order.at(-1)).toBe("T003");
const orderedOverlap = taskGraphCase("ordered_overlap");
expect(() => validateGraph(orderedOverlap, fixtureGraphContextFor(orderedOverlap))).not.toThrow();
```

Run: `npm test -- test/unit/graph/validation.test.ts`

Expected: PASS; the diamond order starts with T001/T002 and ends with T003.

- [ ] **Step 5: Commit**

```bash
git add src/core/task-graph.ts src/core/path-conflicts.ts test/support/factories.ts test/unit/graph/validation.test.ts
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
  expect(result.jobs["record_task_done:T003"].dependsOn).toEqual(["post_integrate_verify:T003"]);
  expect(result.jobs.final_verify.dependsOn).toEqual(["record_task_done:T001", "record_task_done:T002", "record_task_done:T003"]);
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
