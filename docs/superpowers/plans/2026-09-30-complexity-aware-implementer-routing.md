# Complexity-Aware Implementer Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each implementation task through an owner-declared model tier and follow Superpowers' five-round review-fix escalation with durable Pi session continuity.

**Architecture:** Spec Kit emits a v2 task assessment while v1 artifacts remain valid for legacy workflows. A frozen run-start capability snapshot and workflow tier map make the initial route deterministic; journaled fix generations distinguish review feedback from execution retries. Managed Pi sessions and a verified task report live outside disposable worktrees so rounds 1–3 can resume the same transcript and rounds 4–5 can hand off to a fresh, stronger implementer.

**Tech Stack:** TypeScript 7, Node.js >=22.22.2, TypeBox, Vitest, Pi Coding Agent 0.86.1, Spec Kit preset, Git worktrees.

**Spec:** `docs/superpowers/specs/2026-09-30-complexity-aware-implementer-routing-design.md`

## Global Constraints

- Apply complexity routing only to task-scoped `worker.execute`; all other stages retain current model routing.
- Only declared, authenticated, exact provider/model profiles may be candidates. Tier order is `mechanical < standard < complex`; automatic routing never downgrades.
- Fix rounds 1–3 resume the original implementer transcript and profile. Each of rounds 4–5 starts a fresh transcript on a profile at least one tier stronger than the original actual tier. Stop automatic fixes after review of round 5.
- Only accepted task review `changes_requested` starts a fix round. Execution retries and verification failures do not consume fix rounds.
- Persist the profile choice, tier, reason, findings, session identity, and generation-local retry budget without credentials or full prompts. Replay after restart must reproduce the decision.
- Preserve v1 task graph, workflow, resolved-run, and journal replay. Opt-in routing is the only path requiring task metadata and graph v2.
- Keep existing owned-path, commit, assignment-hash, worktree, and independent-review-family checks.

## Review Focus

- A v1 task graph paired with a tiered runner must fail before dispatch with a migration error; Task 3 tests this.
- An unavailable first profile must choose a declared stronger candidate, while an unavailable profile after route acceptance must not silently change the route; Task 3 tests this.
- A repeated `changes_requested` event after restart must not dispatch a second fix round; Task 4 tests this.
- A corrupt or missing Pi transcript must block continuation instead of starting a new session; Task 5 tests this.
- A task already in the strongest tier must visibly block at round 4 if no stronger declared profile exists; Task 4 tests this.

---

### Task 1: Versioned task assessment and graph

**Files:**
- Modify: `src/contracts/task-graph.ts`, `src/speckit/task-records.ts`, `src/speckit/seal-task-graph.ts`, `src/core/task-graph.ts`, `src/speckit/semantic-hash.ts`
- Modify: `presets/harness-task-graph/commands/speckit.tasks.md`, `src/speckit/preset.ts`
- Test: `test/integration/speckit/artifacts.test.ts`, `test/integration/speckit/preset.test.ts`, `test/unit/graph/validation.test.ts`

**Interfaces:**
- Consumes: existing v1 `TaskNode`, `parseSpecKitTasks`, and `validateGraph` behavior.
- Produces: `TaskComplexity = "mechanical" | "standard" | "complex"`, v2 node fields `complexity` and `complexityReason`, and `taskComplexity(task: TaskNode): TaskComplexity | undefined` for legacy-safe consumers.

- [ ] **Step 1: Write failing tests.** Assert exact v2 visible syntax `| complexity=standard | why="Touches parser and CLI contract" | deps=...`, canonical `harness/task-metadata/v2` equality, 500-character reason maximum, v2 semantic hash change, v1 hash stability, and rejection of missing/mismatched assessment.
- [ ] **Step 2: Verify RED.** Run `npx vitest run test/integration/speckit/artifacts.test.ts test/integration/speckit/preset.test.ts test/unit/graph/validation.test.ts`; new v2 cases fail.
- [ ] **Step 3: Implement.** Add discriminated v1/v2 task schemas and parsers; preserve v1 projection and hash byte-for-byte. Update the Spec Kit preset to emit v2 for new tasks while keeping the v1 parser and run loader available. `sealTaskGraph` emits v2 only when given v2 records.
- [ ] **Step 4: Verify GREEN.** Run the same tests plus `npm run typecheck`; all pass.
- [ ] **Step 5: Commit.** Commit production, preset, and test files as `feat: add versioned task complexity assessment`.

### Task 2: Closed tiered runner configuration

**Files:**
- Modify: `src/contracts/workflow.ts`, `src/config/compile.ts`, `src/pi/dependencies.ts`, `src/runtime/production/system.ts`
- Test: `test/unit/config/compiler.test.ts`, `test/unit/core/dynamic-workflow-graph.test.ts`, `test/integration/init.test.ts`

**Interfaces:**
- Consumes: `TaskComplexity` from Task 1 and resolved profile IDs from `ResolvedProfiles.byId`.
- Produces: `ComplexityRunner = { by_complexity: Record<TaskComplexity, readonly string[]> }` and `stageProfileIds(stage: StageDocument): readonly string[]` shared by compiler, preview, and runtime assembly.

- [ ] **Step 1: Write failing tests.** Accept the exact three-tier runner for task-scoped `worker.execute`; reject missing tiers, empty arrays, duplicates across tiers, unknown IDs, wrong profile roles, extra keys, and use on review/planning or singleton implementation stages. Assert legacy string/prefer forms compile unchanged and preview lists all tier candidates.
- [ ] **Step 2: Verify RED.** Run `npx vitest run test/unit/config/compiler.test.ts test/unit/core/dynamic-workflow-graph.test.ts test/integration/init.test.ts`.
- [ ] **Step 3: Implement.** Extend `RunnerSchema`, validate tier membership at compile time, and replace direct `.prefer` assumptions in preview/assembly with `stageProfileIds`. Do not change default workflow files.
- [ ] **Step 4: Verify GREEN.** Run the same tests and `npm run typecheck`.
- [ ] **Step 5: Commit.** Commit as `feat: configure task complexity runners`.

### Task 3: Frozen capability snapshot and initial route

**Files:**
- Modify: `src/state/resolved-run-config.ts`, `src/pi/dependencies.ts`, `src/runtime/production/system.ts`, `src/core/workflow-engine.ts`, `src/core/routing.ts`, `src/contracts/events.ts`, `src/core/reducer.ts`, `src/core/state.ts`
- Test: `test/unit/state/resolved-run-config.test.ts`, `test/unit/core/routing.test.ts`, `test/unit/core/workflow-engine.test.ts`, `test/integration/production/run-initialization.test.ts`

**Interfaces:**
- Consumes: v2 assessment, compiled tier map, and `PiWorkerRuntime.probe(profile)`.
- Produces: `ProfileCapabilitySnapshot = Readonly<Record<string, { available: boolean; evidence: readonly string[] }>>` in the frozen run config; `selectInitialComplexityRoute(input: { complexity: TaskComplexity; runner: ComplexityRunner; capabilities: ProfileCapabilitySnapshot }): { profileId: string; actualTier: TaskComplexity; candidates: readonly string[] } | { blockReason: string }`; durable `worker.routed` evidence for the selected assessment and profile.

- [ ] **Step 1: Write failing tests.** Prove same-tier preference, fallback only upward, no candidate block, exact available-model preflight, and a frozen route surviving replay even when a live probe later changes. Pair a v1 graph with a tiered runner and assert a migration error before dispatch. Check no API keys or prompts enter the snapshot or event.
- [ ] **Step 2: Verify RED.** Run `npx vitest run test/unit/state/resolved-run-config.test.ts test/unit/core/routing.test.ts test/unit/core/workflow-engine.test.ts test/integration/production/run-initialization.test.ts`.
- [ ] **Step 3: Implement.** Probe all tier-declared profiles once at run creation, write the bounded snapshot with resolved config, pass it to the pure command deriver, and journal one accepted route per task. Recovery reads the frozen snapshot, not fresh ambient catalog state. Legacy resolved-run records without a snapshot remain valid.
- [ ] **Step 4: Verify GREEN.** Run the same tests and `npm run typecheck`.
- [ ] **Step 5: Commit.** Commit as `feat: freeze and route eligible implementation profiles`.

### Task 4: Durable five-round review-fix state machine

**Files:**
- Modify: `src/contracts/events.ts`, `src/core/state.ts`, `src/core/reducer.ts`, `src/core/lifecycle.ts`, `src/core/workflow-engine.ts`, `src/core/materialize.ts`
- Test: `test/unit/core/reducer.test.ts`, `test/unit/core/workflow-engine.test.ts`, `test/e2e/durable-workflow.test.ts`, `test/e2e/crash-matrix.test.ts`

**Interfaces:**
- Consumes: accepted `review.changes_requested`, frozen route and tiers, existing operator `reroute`, and stage retry limits.
- Produces: `ImplementationLineage` in state with `fixRound`, `generation`, selected original profile/tier, pending reviewed commit/findings, and monotonically increasing global attempt IDs; pure next-route decision for rounds 1–5.

- [ ] **Step 1: Write failing tests.** Assert round 0 initial, review findings dispatch rounds 1–3 on original profile, rounds 4–5 on a strictly stronger tier, stop after reviewed round 5, strongest-tier block, duplicate event idempotency, operator override without fix-round reset, and fresh per-generation implement/review retry budgets. Assert infrastructure and verification retries do not increment `fixRound`.
- [ ] **Step 2: Verify RED.** Run `npx vitest run test/unit/core/reducer.test.ts test/unit/core/workflow-engine.test.ts test/e2e/durable-workflow.test.ts test/e2e/crash-matrix.test.ts`.
- [ ] **Step 3: Implement.** Add explicit lineage/fix-round events and reducer transitions. Keep legacy job attempt semantics when no tiered runner is configured. Bind route/fix generation to idempotency keys, effect inputs, and accepted review commit so replay cannot schedule a second fix.
- [ ] **Step 4: Verify GREEN.** Run the same tests and `npm run typecheck`.
- [ ] **Step 5: Commit.** Commit as `feat: track durable implementation fix rounds`.

### Task 5: Managed Pi continuation and verified handoff report

**Files:**
- Create: `src/runtime/pi-worker/task-session.ts`, `src/runtime/workers/handoff-report.ts`
- Modify: `src/runtime/pi-worker/launch-spec.ts`, `src/runtime/pi-worker/runtime.ts`, `src/runtime/production/pi-worker.ts`, `src/runtime/production/worker-attempts.ts`, `src/runtime/production/system.ts`, `src/runtime/workers/prompt.ts`, `src/state/paths.ts`, `src/state/types.ts`
- Test: `test/unit/runtime/pi-launch-spec.test.ts`, `test/unit/runtime/pi-production-worker.test.ts`, `test/integration/pi-worker/profiles.test.ts`, `test/integration/production/worker-attempts.test.ts`, `test/e2e/crash-matrix.test.ts`

**Interfaces:**
- Consumes: `ImplementationLineage`, selected route/fix round, accepted worker evidence and review findings.
- Produces: `TaskSessionStore` with `create`, `verify`, and `resume` operations under the managed run root; `buildHandoffReport` from verified evidence with a 1 MiB maximum and content hash; `buildPiLaunchSpec` accepts a new-session or explicit-resume selection.

- [ ] **Step 1: Write failing tests.** Assert rounds 1–3 pass Pi `--session <verified path or ID>` and retain session identity across disposable worktrees; rounds 4 and 5 create distinct fresh sessions; the report contains all accepted findings and verified test evidence; missing/corrupt/oversize session or report blocks. Test task-scoped ownership, private regular files, and one active writer per transcript.
- [ ] **Step 2: Verify RED.** Run `npx vitest run test/unit/runtime/pi-launch-spec.test.ts test/unit/runtime/pi-production-worker.test.ts test/integration/pi-worker/profiles.test.ts test/integration/production/worker-attempts.test.ts test/e2e/crash-matrix.test.ts`.
- [ ] **Step 3: Implement.** Store Pi transcripts and the controller-built report outside `.harness-output`; pass verified continuation identity into the launch spec, maintain unique assignment hashes/tokens, include fresh worktree/commit/findings in every follow-up prompt, and never resume a different profile on one transcript. Keep existing process recovery and cleanup fencing.
- [ ] **Step 4: Verify GREEN.** Run the same tests and `npm run typecheck`.
- [ ] **Step 5: Commit.** Commit as `feat: preserve implementer sessions across fix rounds`.

### Task 6: Real Pi continuation proof, operator visibility, and documentation

**Files:**
- Modify: `src/cli/status.ts`, `src/cli/explain.ts`, `src/pi/status-view.ts`, `docs/workflow-dsl.md`, `docs/model-profiles.md`, `README.md`
- Test: `test/integration/pi-worker/session-continuation.test.ts`, `test/integration/operations.test.ts`, `test/unit/pi-commands.test.ts`, `test/e2e/production-pipeline.test.ts`

**Interfaces:**
- Consumes: journaled route and lineage events plus `TaskSessionStore` from Tasks 3–5.
- Produces: status/explain output with complexity, selected tier/profile, fix round, pending findings, and block reason; copyable tiered-runner configuration guidance.

- [ ] **Step 1: Write failing tests.** Use the pinned Pi CLI to start and resume a session from a separate attempt worktree; assert second turn sees first-turn context. Test status/explain fields, `no_escalation_profile`, and a v1 project that still executes unchanged. Use a deterministic local OpenAI-compatible fake server for the Pi CLI test so no hosted credential is required; the real Pi session loader and `--session` path must remain in the test path.
- [ ] **Step 2: Verify RED.** Run `npx vitest run test/integration/pi-worker/session-continuation.test.ts test/integration/operations.test.ts test/unit/pi-commands.test.ts test/e2e/production-pipeline.test.ts`.
- [ ] **Step 3: Implement.** Add operator-readable route/fix explanations and profile-discovery documentation. If the pinned Pi CLI cannot resume a session across worktree paths, fix the managed session design before claiming this task complete; do not replace it with a mocked CLI assertion.
- [ ] **Step 4: Verify GREEN.** Run the same tests, `npm run typecheck`, and `npm run build`.
- [ ] **Step 5: Commit.** Commit as `feat: expose and verify complexity routing`.

## Final verification

- [ ] Run `npm run verify`; record exact result.
- [ ] Run `git diff --check` and inspect the full branch diff against its base for spec coverage, stale paths, secrets, and unintended default-workflow changes.
- [ ] Verify recovery from an accepted review awaiting fix dispatch and from an active implementation attempt; confirm no duplicate fix or concurrent transcript writer.
- [ ] Report any real-provider or credentialed end-to-end tests that were not run. Do not claim model quality from protocol tests.
