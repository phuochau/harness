# Pi Multi-Agent Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Pi package and `harness` CLI that turns Spec Kit artifacts into durable, policy-governed, multi-agent runs across Devin, Codex, and Claude through Herdr.

**Architecture:** One TypeScript package contains deterministic contracts, a fenced event store, a serialized resident controller, generic recoverable effects, Herdr-backed worker execution, Spec Kit planning, Git integration, a Pi extension, and a trusted clean-machine bootstrap. This file is the execution index; the exact TDD steps live in five phase plans so a worker never receives an entire multi-subsystem build as one task.

**Tech Stack:** Node.js 22+, TypeScript ESM, `@earendil-works/pi-coding-agent@0.86.1`, `typebox@1.3.34`, Ajv with `ajv-formats`, YAML, Vitest, fast-check, Git CLI, GitHub CLI, Herdr CLI/socket API, and Spec Kit presets.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Locked Decisions

- The npm package name for the MVP is `pi-multi-agent-harness`; `@pi-harness/cli` is owned by another project and must not be used.
- Pi is the only global orchestrator. Herdr is an execution plane and lifecycle authority, never a scheduler.
- Node.js 22 or newer is the sole clean-machine prerequisite.
- The controller is single-writer both across processes and inside one process: an exclusive lock-directory lease plus fencing prevents stale writes; a serialized command queue prevents concurrent derivation.
- Every external action declares `idempotent`, `reconcilable`, or `non_retryable` recovery semantics and implements both `execute()` and `reconcile()`.
- An unknown result for a `non_retryable` effect becomes `BLOCKED`; it is never replayed automatically.
- The built-in trust baseline permits only exact official identities and integrity rules embedded in the exact-version harness package. Trust in that baseline derives from the package identity and registry-verified tarball integrity, not from an undefined second signature scheme. Machine and project policies may narrow it; a machine policy may add a separately approved source.
- Implementers and reviewers never share a working directory. Review uses a separate detached, read-only worktree pinned to the implementation commit.
- Planning completion is bound to a durable Pi custom-entry correlation marker, the correlated agent run's final `turnIndex`, `agent_settled`, and stage-specific pre/post artifact hashes; an intermediate or unrelated `turn_end` cannot accept stale artifacts.
- Real compatibility checks occur at the milestone that introduces Herdr, Spec Kit, or Pi. Subscription-consuming worker checks remain gated.

## Global Constraints

- Codex, Devin, and Claude are first-class worker kinds. Default implementation preference is `[devin, codex, claude]`; default review preference is `[codex, claude, devin]`.
- A reviewer must be a different worker kind from the implementation worker. No eligible reviewer means `BLOCKED`.
- Superpowers is worker-only. The worker allowlist excludes planning, delegation, parallel-agent dispatch, worktree management, and branch-finishing skills.
- Workers may read but never modify `spec.md`, `plan.md`, `tasks.md`, `task-graph.json`, `.harness/`, or `.pi/`.
- Runtime state lives below `<git-common-dir>/harness/runs`; only the resident controller writes it.
- An active run's compiled workflow is immutable. Changed workflow content creates a new revision.
- Bootstrap executes no repository code before approval and installs only locked sources allowed by the effective trust policy.
- Final pull-request creation requires GitHub CLI, authenticated GitHub remote, full verification, and final diff review.
- Scope is local-only: no Tailscale, remote control, Pi Web, dashboards, multi-machine Herdr, or Devin API transport.

## Review Focus

- Crash after intent but before observation: enter the recovery path, reconcile the existing effect, and never launch it twice; a fresh effect never reconciles before its first execution. Owned by Tasks 11, 12, 15, and 33.
- Timer, Herdr, Pi, and operator wakeups race: serialize them and append one intent/observation pair. Owned by Tasks 12 and 33.
- Stale controller resumes after lease takeover: reject its fencing token. Owned by Tasks 7–9.
- Dynamic graph has duplicate keys, invalid joins, cycles, unknown IDs, or unordered file overlap: reject before materialization. Owned by Tasks 5–6.
- Reviewer mutates or observes a different commit: reject the review evidence. Owned by Tasks 17 and 23.
- A correlated planning run settles without producing its required artifact delta: block it; unrelated/intermediate turns keep it pending. Owned by Task 25.
- Clean machine has no external policy: built-in baseline can install only exact release-manifest sources. Owned by Tasks 29–31.
- Repository supplies lifecycle scripts or executable config: pre-approval bootstrap never runs it. Owned by Tasks 30–31.

## Phase Plans and Milestone Gates

Execute tasks strictly in numeric order. Every task ends in an independently reviewable commit.

| Phase | Tasks | Deliverable | Gate |
|---|---:|---|---|
| [Phase 1 — Package and deterministic contracts](./2026-09-20-pi-orchestrator-phase-1-foundation.md) | 1–6 | Loadable CLI/extension stubs, schemas, compiler, validated DAG, materialized jobs | `npm run check:phase1` and independent review |
| [Phase 2 — Durable state and controller](./2026-09-20-pi-orchestrator-phase-2-durable-core.md) | 7–15 | Fenced store, recovery, effect protocol, serialized queue, fake end-to-end controller | `npm run check:phase2` and crash/race review |
| [Phase 3 — Git and Herdr execution](./2026-09-20-pi-orchestrator-phase-3-execution.md) | 16–23 | Branch/worktree lifecycle, actions, Herdr client/runtime, three worker adapters | `npm run check:phase3` and real non-subscription Herdr smoke |
| [Phase 4 — Spec Kit, Pi, and runnable defaults](./2026-09-20-pi-orchestrator-phase-4-pi-speckit.md) | 24–28 | Correlated planning, real Pi loader compatibility, default editable DSL, resident commands | `npm run check:phase4` and real Spec Kit/Pi compatibility jobs |
| [Phase 5 — Bootstrap, recovery, and release](./2026-09-20-pi-orchestrator-phase-5-release.md) | 29–34 | Trusted clean-machine setup, operations, crash matrix, packed release | `npm run verify`, package inspection, final review |

## Task Ledger

1. Scaffold a loadable package, CLI, and Pi extension stub.
2. Define versioned external schemas and exact domain types.
3. Add typed test factories used by later task examples.
4. Compile and freeze workflow configuration.
5. Validate the Spec Kit task graph.
6. Materialize keyed fan-out, joins, barriers, and task projection.
7. Resolve shared run paths and acquire a fenced lease.
8. Append hash-chained events with duplicate-key protection.
9. Write snapshots and recover from torn tails.
10. Reduce events into deterministic run state.
11. Define the generic effect registry and recovery classes.
12. Serialize every controller command source.
13. Apply routing, retry, and independent-review policy.
14. Build immutable assignments and validate evidence.
15. Run the scheduler/controller end-to-end against fake effects.
16. Create planning, integration, and task branches.
17. Enforce implementation/review/remediation worktree ownership.
18. Add command and human-approval actions.
19. Add Git verification, integration, push, and PR actions.
20. Generate and validate the Herdr protocol client.
21. Reconcile Herdr workspaces, panes, and agents.
22. Define the shared worker adapter contract.
23. Implement Codex, Devin, and Claude adapters.
24. Ship the Spec Kit graph preset and artifact validator.
25. Correlate Pi planning runs with new artifact hashes.
26. Load the extension through Pi's real resource loader.
27. Generate a complete editable default workflow on `harness init`.
28. Run resident scheduling and semantic operator commands in Pi.
29. Probe capabilities and compute the effective trust baseline.
30. Build install plans, typed recipes, and receipts.
31. Implement `bootstrap` and `doctor` without pre-approval execution.
32. Implement `start`, `status`, `graph`, `explain`, and `recover`.
33. Prove black-box execution, crash recovery, and race safety.
34. Package, document, and verify the release.

## Test Support Ownership

Test helpers are production-typed fixtures, not implicit pseudocode. Each task
that first uses a symbol must create or extend the file below in the same commit.
Later tasks may consume it only after that owning task passes typecheck.

| Owner | File | Required exports |
|---|---|---|
| Task 3 | `test/support/factories.ts` | `fixtureWorkflow`, `fixtureEnvironment`, `fixtureCompileInput`, `fixtureTaskGraph`, `fixtureGraphContext`, `diamondTaskGraph`, `fixtureEvent`, `completedResult` |
| Tasks 7–11 | `test/support/state-fixtures.ts` | `createTempRepoWithWorktree`, `journalFixture`, `fixtureEventInput`, `persistedRunFixture`, `fixtureEventsThroughWorkerCompletion`, `fixtureSuccessfulTaskEvents`, `fixtureEventsWithIntentObservationPauseRetryAndPlanning`, `replay`, `fakeHandler`, `effectExecutor`, `fixtureIntent`, `actionContext`, `recoveryContext` |
| Tasks 12–15 | `test/support/controller-fixtures.ts` | `controllerQueueFixture`, `command`, `routeFixture`, `reviewFixture`, `assignmentFixture`, `reviewAssignment`, `createControllerFixture`, `successfulFakeResults` |
| Tasks 16–19 | `test/support/git-fixtures.ts` | `createTempRepoWithIntegratedDependencies`, `worktreeFixture`, `taskAttempt`, `reviewAttempt`, `cleanReviewBinding`, `expectedArtifactHashes`, `fakeProcess`, `fakeCommandLedger`, `commandIntent`, `approvalIntent`, `fakeApprovals`, `integratedGitFixture`, `gitIntegrateIntent`, `prIntent` |
| Tasks 20–23 | `test/support/herdr-fixtures.ts` | `FakeHerdrTransport`, `herdrRuntimeFixture`, `agentSnapshot`, `attemptLabels`, `workerStartIntent`, `contractAssignment`, `preparedWorker`, `workerAdapters` |
| Tasks 24–28 | `test/support/planning-fixtures.ts` | `resolvePresetFixture`, `artifactPathsFixture`, `artifactContractFixture`, `emptyArtifactBaseline`, `planningFixture`, `validArtifactSet`, `changedArtifactSet`, `copyProjectFixture`, `runHarness`, `initializedProject`, `piResidencyFixture` |
| Tasks 29–32 | `test/support/install-fixtures.ts` | `builtInBaseline`, `projectPolicy`, `denySource`, `allowEverythingProjectPolicy`, `lockedSource`, `lockWithUnknownSource`, `missingProbes`, `safeNpmPlan`, `approved`, `maliciousProjectFixture`, `operationsFixture` |
| Task 33 | `test/support/black-box-harness.ts` | `createBlackBoxHarness`, `crashableHarness` |
| Task 34 | `test/support/package-consumer.ts` | `packHarness`, `installPackedHarness` |

The base helper introduced in Task 3 is the only override mechanism:

```ts
export function fixture<T>(base: () => T): (overrides?: DeepPartial<T>) => T {
  return (overrides = {}) => deepFreeze(deepMerge(base(), overrides));
}
```

Factories must return schema-valid values by default. A test that needs invalid
wire data must construct `unknown` explicitly so invalid fixtures never leak
into unrelated tests.

## Cross-Phase Public Interfaces

Later phase plans must consume these exact shapes; changing one requires updating every consumer before implementation continues.

```ts
export type RecoveryClass = "idempotent" | "reconcilable" | "non_retryable";

export interface EffectIntent<K extends string = string, I = unknown> {
  action: K;
  idempotencyKey: string;
  recovery: RecoveryClass;
  laneKey: string;
  input: I;
}

export type ReconcileResult<O> =
  | { status: "not_found" }
  | { status: "observed"; output: O }
  | { status: "indeterminate"; evidence: string[] };

export interface ProcessRunner {
  run(executable: string, argv: readonly string[], options: { cwd?: string; env?: Readonly<Record<string, string>>; shell: false; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface GitPort {
  patchId(commit: string): Promise<string>;
  findPatchId(branch: string, patchId: string): Promise<string | undefined>;
  revParse(ref: string): Promise<string>;
  status(path: string): Promise<readonly string[]>;
}

export interface ApprovalStore {
  get(requestId: string): Promise<{ approved: boolean; actor: string; recordedAt: string } | undefined>;
}

export interface Clock {
  now(): Date;
}

export interface ActionContext {
  readonly isRecovery: boolean;
  readonly process: ProcessRunner;
  readonly git: GitPort;
  readonly approvals: ApprovalStore;
  readonly clock: Clock;
  readonly signal: AbortSignal;
}

export interface ActionHandler<K extends string = string, I = unknown, O = unknown> {
  readonly kind: K;
  recovery(input: I): RecoveryClass;
  execute(context: ActionContext, intent: EffectIntent<K, I>): Promise<O>;
  reconcile(context: ActionContext, intent: EffectIntent<K, I>): Promise<ReconcileResult<O>>;
}

export interface ControllerCommand {
  source: "timer" | "herdr" | "pi" | "operator" | "recovery";
  kind: "tick" | "runtime_event" | "operator_intent" | "planning_turn" | "recover";
  idempotencyKey: string;
  payload: unknown;
}

export interface PlanningRunReceipt {
  sessionFile: string;
  correlationId: string;
  requestEntryId: string;
  startedAt: string;
  completedAt?: string;
}

export interface WorktreeBinding {
  role: "implementation" | "review" | "verification" | "remediation";
  path: string;
  branch: string | null;
  commit: string;
  writable: boolean;
}
```

## Verification Commands

Each phase adds its script before using it:

```json
{
  "scripts": {
    "check:phase1": "npm run typecheck && npm run build && vitest run test/unit/contracts test/unit/config test/unit/graph test/integration/package-smoke.test.ts",
    "check:phase2": "npm run check:phase1 && vitest run test/unit/state test/unit/core test/integration/controller-race.test.ts test/e2e/fake-controller.test.ts",
    "check:phase3": "npm run check:phase2 && vitest run test/integration/git test/integration/herdr test/contract/workers.test.ts",
    "check:phase4": "npm run check:phase3 && vitest run test/integration/speckit test/integration/pi-loader.test.ts test/integration/init.test.ts test/integration/pi-residency.test.ts",
    "verify": "npm run typecheck && vitest run && npm run build && npm pack --dry-run"
  }
}
```

Real compatibility jobs use `HARNESS_COMPAT_HERDR=1`, `HARNESS_COMPAT_SPECKIT=1`, and `HARNESS_COMPAT_PI=1`. Subscription-consuming workers additionally require `HARNESS_E2E_REAL=1`; normal CI never spends subscription usage.

## Completion Rule

Do not start a later phase until the current phase command passes and its review findings are resolved. The harness is complete only after Task 34, `npm run verify`, packed-artifact inspection, and a final diff review all pass. A green unit suite alone is not completion.
