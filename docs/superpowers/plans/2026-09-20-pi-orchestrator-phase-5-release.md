# Pi Orchestrator Phase 5: Bootstrap, Recovery, and Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Provision a clean machine from declarative locked inputs, operate and recover runs safely, then prove and package the release.

**Architecture:** A trusted external CLI reads only declarative harness files and Git metadata before approval. Effective trust is the intersection of the immutable signed-release baseline, optional machine policy, project policy, and exact lock. Operational recovery reuses the same fenced event/effect protocol as the resident controller.

**Tech Stack:** Node.js 22+, npm/package-manager probes, Git/GitHub/Herdr CLIs, TypeScript, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Task 29: Probe Capabilities and Compute Effective Trust

**Files:**
- Create: `src/install/types.ts`, `release-manifest.ts`, `baseline-policy.ts`, `policy.ts`, `probes.ts`
- Create: `src/defaults/release-manifest.json`
- Create: `test/support/install-fixtures.ts`
- Test: `test/unit/install/policy.test.ts`, `test/integration/install/probes.test.ts`

**Interfaces:**
- Produces `probeEnvironment(context): CapabilityReport` and `effectivePolicy(baseline, machine, project): EffectivePolicy`.
- Missing machine policy does not mean deny-all; it means the immutable baseline remains in force.

- [ ] **Step 1: Write clean-machine and narrowing tests**

```ts
it("allows exact release-manifest sources without an external machine policy", () => {
  const policy = effectivePolicy(builtInBaseline(), undefined, projectPolicy());
  expect(policy.allows(lockedSource("pi-multi-agent-harness"))).toBe(true);
  expect(policy.allows({ kind: "npm", name: "unknown", version: "1.0.0", integrity: "sha512-x" })).toBe(false);
});

it("lets machine and project policy narrow but not silently broaden", () => {
  const policy = effectivePolicy(builtInBaseline(), denySource("herdr"), allowEverythingProjectPolicy());
  expect(policy.allows(lockedSource("herdr"))).toBe(false);
});
```

- [ ] **Step 2: Run and observe missing install policy**

Run: `npm test -- test/unit/install/policy.test.ts test/integration/install/probes.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define exact release identities and policy intersection**

```ts
export interface TrustedSource {
  kind: "npm" | "formula" | "signed-artifact";
  identity: string;
  version: string;
  integrity: string;
}

export function effectivePolicy(baseline: TrustPolicy, machine: TrustPolicy | undefined, project: TrustPolicy): EffectivePolicy {
  const ceiling = machine ? applyMachineAmendments(baseline, machine) : baseline;
  return intersectPolicies(ceiling, project);
}
```

`release-manifest.json` contains exact identities and integrity-verification rules for the harness, `@mariozechner/pi-coding-agent`, Spec Kit, Superpowers, Herdr, four Herdr integrations, Codex CLI, Devin CLI, Claude Code, Git, and GitHub CLI. Generated releases replace versions/digests atomically; project files cannot alter the built-in manifest.

- [ ] **Step 4: Implement shell-free fresh probes**

```ts
export async function probeExecutable(process: ProcessRunner, capability: Capability): Promise<ProbeResult> {
  const result = await process.run(capability.command, capability.versionArgs, { shell: false, timeoutMs: 10_000 });
  return result.exitCode === 0
    ? { id: capability.id, status: "present", version: capability.parseVersion(result.stdout) }
    : { id: capability.id, status: "missing", evidence: [result.stderr] };
}
```

Probe auth as status only; never return token values. Run: `npm test -- test/unit/install/policy.test.ts test/integration/install/probes.test.ts`.

Expected: PASS for no machine file, machine denial, separately approved machine source, project narrowing, missing binary, wrong version, missing auth, and paths with spaces.

- [ ] **Step 5: Commit**

```bash
git add src/install src/defaults/release-manifest.json test/unit/install test/integration/install/probes.test.ts
git commit -m "feat: define bootstrap trust and probes"
```

## Task 30: Build Install Plans, Typed Recipes, and Receipts

**Files:**
- Create: `src/install/plan.ts`, `recipes.ts`, `executor.ts`, `receipts.ts`
- Modify: `test/support/install-fixtures.ts`
- Test: `test/integration/install/plan.test.ts`, `executor.test.ts`

**Interfaces:**
- Produces `createInstallPlan(lock, probes, policy)` and `executeInstallPlan(plan, approval)`.
- Recipes are exact-version npm, allowlisted formula, signed artifact with digest, or manual.

- [ ] **Step 1: Write plan/recipe safety tests**

```ts
it("marks unknown or unverifiable dependencies manual", () => {
  const plan = createInstallPlan(lockWithUnknownSource(), missingProbes(), builtInPolicy());
  expect(plan.steps[0]).toMatchObject({ mode: "manual", blocking: true });
});

it("never invokes a shell or repository lifecycle script", async () => {
  const process = new FakeProcessRunner();
  await executeInstallPlan(safeNpmPlan({ ignoreScripts: true }), approved(), { process });
  expect(process.calls[0]).toMatchObject({ executable: "npm", options: { shell: false } });
  expect(process.calls[0].argv).toContain("--ignore-scripts");
});
```

- [ ] **Step 2: Run and observe missing planner/executor**

Run: `npm test -- test/integration/install/plan.test.ts test/integration/install/executor.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement ordered, content-addressed plans**

```ts
export function createInstallPlan(lock: HarnessLock, probes: CapabilityReport, policy: EffectivePolicy): InstallPlan {
  const steps = dependencyOrder(lock.dependencies).map((dependency) => {
    const probe = probes.byId[dependency.id];
    if (probe.status === "present" && probe.version === dependency.version) return skippedStep(dependency, "already satisfied");
    if (!policy.allows(dependency.source)) return manualStep(dependency, "source not trusted by effective policy");
    return recipeStep(dependency, recipeFor(dependency));
  });
  const body = { schemaVersion: 1 as const, lockHash: hashLock(lock), steps };
  return deepFreeze({ ...body, planHash: sha256(canonicalJson(body)) });
}
```

Every automatic step records argv, cwd, source, integrity, scope, expected mutations, probe-after, and rollback guidance. `--yes` is accepted only for a plan whose automatic steps are all baseline/machine trusted and lock-matched.

- [ ] **Step 4: Execute step-by-step and write secret-free receipts**

```ts
for (const step of plan.steps) {
  if (step.mode === "manual") throw new ManualDependency(step.instructions);
  if (step.mode === "automatic") {
    await runner.run(step.executable, step.argv, { cwd: trustedInstallCwd, env: sanitizedInstallEnv(), shell: false });
    const result = await probes.run(step.probeAfter);
    if (result.status !== "present" || result.version !== step.expectedVersion) throw new InstallVerificationError(step.id);
    await receipts.append(redactReceipt(step, result));
  }
}
```

Run: `npm test -- test/integration/install/plan.test.ts test/integration/install/executor.test.ts`.

Expected: PASS for idempotency, partial failure, repair, checksum mismatch, manual step, disallowed source, and receipt redaction.

- [ ] **Step 5: Commit**

```bash
git add src/install/plan.ts src/install/recipes.ts src/install/executor.ts src/install/receipts.ts test/integration/install/plan.test.ts test/integration/install/executor.test.ts
git commit -m "feat: plan trusted dependency installation"
```

## Task 31: Implement Bootstrap and Doctor Without Pre-Approval Execution

**Files:**
- Create: `src/cli/bootstrap.ts`, `doctor.ts`, `trusted-project-reader.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/support/install-fixtures.ts`
- Test: `test/integration/bootstrap.test.ts`, `doctor.test.ts`
- Fixtures: `test/fixtures/install/`

**Interfaces:**
- Produces `harness bootstrap [--dry-run|--repair|--yes] [path]` and `harness doctor [--json] [path]`.
- Before approval, allowed reads are `.harness/*.yaml`, `.harness/harness.lock`, `.git` metadata, and the installed release manifest.

- [ ] **Step 1: Write malicious-repository trap test**

```ts
it("does not execute repository content before approval", async () => {
  const repo = await maliciousProjectFixture({
    packageLifecycleScript: "node -e \"require('fs').writeFileSync('owned','yes')\"",
    workflowArgv: ["node", "-e", "require('fs').writeFileSync('owned2','yes')"],
    piExtension: "throw new Error('loaded')",
  });
  await runHarness(["bootstrap", "--dry-run", repo]);
  expect(await exists(join(repo, "owned"))).toBe(false);
  expect(await exists(join(repo, "owned2"))).toBe(false);
  expect(await auditReadsOutsideAllowedSet(repo)).toEqual([]);
});
```

- [ ] **Step 2: Run and observe missing commands**

Run: `npm test -- test/integration/bootstrap.test.ts test/integration/doctor.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement a declarative-only bootstrap boundary**

```ts
export async function bootstrap(options: BootstrapOptions, deps: BootstrapDependencies): Promise<BootstrapResult> {
  const project = await readDeclarativeProject(options.root, ALLOWED_PRE_APPROVAL_PATHS);
  assertLauncherMatchesLock(HARNESS_VERSION, project.lock.harnessVersion);
  const probes = await probeEnvironment(deps.probeContext);
  const policy = effectivePolicy(deps.releaseBaseline, await readMachinePolicy(), project.policy);
  const plan = createInstallPlan(project.lock, probes, policy);
  await deps.presenter.show(plan);
  if (options.dryRun) return { status: "planned", plan };
  const approval = await deps.approvals.requirePlanHash(plan.planHash, options.yes);
  await executeInstallPlan(plan, approval, deps);
  return { status: "installed", report: await doctor({ root: options.root }, deps) };
}
```

Do not import repository modules, invoke package scripts, load `.pi` extensions, start Pi/Herdr, or execute workflow commands before plan-hash approval.

- [ ] **Step 4: Implement machine-readable doctor**

`doctor --json` emits one schema-versioned report with capability ID, status, installed/required version, source, and redacted evidence. It freshly probes Node, Git, GitHub/auth/remote, Pi/package/planning profile, Spec Kit/preset, Superpowers, Herdr/integrations, three workers, policies, config, and runtime directories; receipts are diagnostics only.

```ts
export async function doctor(options: DoctorOptions, deps: DoctorDependencies): Promise<DoctorReport> {
  const results = await Promise.all(REQUIRED_CAPABILITIES.map((capability) => deps.probes.run(capability, options.root)));
  return validateDoctorReport({
    schemaVersion: 1,
    ok: results.every((result) => result.status === "present" || result.status === "authenticated"),
    capabilities: results.map(redactProbeResult),
    checkedAt: deps.clock.now().toISOString(),
  });
}
```

Run: `npm test -- test/integration/bootstrap.test.ts test/integration/doctor.test.ts`.

Expected: PASS for clean-machine baseline, dry-run, approved install, `--yes` denial, duplicate bootstrap, repair, malicious files, missing auth, and JSON redaction.

- [ ] **Step 5: Commit**

```bash
git add src/cli/bootstrap.ts src/cli/doctor.ts src/cli/trusted-project-reader.ts src/cli/main.ts test/integration/bootstrap.test.ts test/integration/doctor.test.ts test/fixtures/install
git commit -m "feat: bootstrap trusted harness machines"
```

## Task 32: Implement Start, Status, Graph, Explain, and Recover

**Files:**
- Create: `src/cli/start.ts`, `status.ts`, `graph.ts`, `explain.ts`, `recover.ts`
- Create: `src/controller/reconcile-run.ts`
- Modify: `test/support/install-fixtures.ts`
- Test: `test/integration/operations.test.ts`

**Interfaces:**
- Produces operational CLI commands; `recover` proposes/records reconciliation but does not schedule while Pi is unavailable.

- [ ] **Step 1: Write duplicate-start and recovery tests**

```ts
it("reattaches the dedicated Pi agent instead of starting a duplicate", async () => {
  const fixture = await operationsFixture({ existingPiAgent: true });
  await fixture.run(["start"]);
  expect(fixture.herdr.calls("agent.start")).toHaveLength(0);
  expect(fixture.output).toContain("reattached");
});

it("recovers effects but does not schedule without Pi", async () => {
  const fixture = await operationsFixture({ piAvailable: false, unobservedIntent: true });
  await fixture.run(["recover"]);
  expect(fixture.events).toContainEqual(expect.objectContaining({ eventType: "effect.observed" }));
  expect(fixture.events).not.toContainEqual(expect.objectContaining({ eventType: "attempt.started" }));
});
```

- [ ] **Step 2: Run and observe missing commands**

Run: `npm test -- test/integration/operations.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement stable Pi workspace/agent identity**

```ts
export async function start(options: StartOptions, deps: OperationDependencies): Promise<StartResult> {
  const repo = await deps.git.inspect(options.root);
  const workspace = await deps.herdr.ensureWorkspace({ label: `harness:${repo.identity}`, cwd: repo.root });
  const existing = await deps.herdr.findAgent({ workspaceId: workspace.id, labels: { role: "harness-controller", repository: repo.identity } });
  const agent = existing ?? await deps.herdr.startAgent({ kind: "pi", workspaceId: workspace.id, cwd: repo.root, labels: { role: "harness-controller", repository: repo.identity } });
  await deps.herdr.waitFor(agent.id, "idle");
  await deps.extensionProbe.assertReady(agent.id);
  return { mode: existing ? "reattached" : "started", agent };
}
```

- [ ] **Step 4: Implement explicit recovery and read-only views**

```ts
export async function recoverRun(run: RunRef, deps: RecoveryDependencies): Promise<RecoverySummary> {
  const lease = await RunLease.acquire(run.paths, deps.ownerId);
  const journal = await recoverJournal(run.paths);
  const state = replay(journal.events);
  for (const intent of unobservedIntents(state)) await deps.effects.reconcileOnly(intent, lease);
  await deps.repository.snapshot();
  return summarizeRecovery(state, { schedulingEnabled: false });
}
```

`status`, `graph`, and `explain` validate then read state/events only. `recover` checks Herdr agents, worktrees, branches, commits, results, push, and PR identities; an indeterminate non-retryable effect becomes a blocker.

Run: `npm test -- test/integration/operations.test.ts`.

Expected: PASS for duplicate start, missing Herdr, Pi unavailable, torn tail, stale lease, reconciled effect, indeterminate effect, and read-only commands.

- [ ] **Step 5: Commit**

```bash
git add src/cli/start.ts src/cli/status.ts src/cli/graph.ts src/cli/explain.ts src/cli/recover.ts src/controller/reconcile-run.ts test/integration/operations.test.ts
git commit -m "feat: operate and recover harness runs"
```

## Task 33: Prove Black-Box Execution, Crash Recovery, and Race Safety

**Files:**
- Create: `src/composition-root.ts`
- Create: `test/support/black-box-harness.ts`, `fault-injector.ts`
- Create: `test/e2e/fake-feature.test.ts`, `crash-matrix.test.ts`, `race-matrix.test.ts`
- Fixtures: `test/e2e/fixtures/sample-feature/`

**Interfaces:**
- Produces `createHarnessSystem(ports): HarnessSystem`; production and tests replace only explicit ports.

- [ ] **Step 1: Write black-box feature test through public entrypoints**

```ts
it("takes a diamond feature to one PR", async () => {
  const system = await createBlackBoxHarness({ graph: diamondTaskGraph(), actionResults: successfulFakeResults() });
  const result = await system.runToQuiescence();
  expect(result.taskStates).toEqual({ T001: "DONE", T002: "DONE", T003: "DONE" });
  expect(result.maxConcurrentImplementation).toBe(2);
  expect(result.reviews.every((review) => review.worker !== review.implementationWorker)).toBe(true);
  expect(result.pullRequests).toHaveLength(1);
});
```

- [ ] **Step 2: Run and observe missing composition root**

Run: `npm test -- test/e2e/fake-feature.test.ts`

Expected: FAIL.

- [ ] **Step 3: Wire one explicit composition root**

```ts
export function createHarnessSystem(ports: HarnessPorts): HarnessSystem {
  const actions = registerActions(ports);
  const repository = new RunRepository(ports.storage, ports.clock);
  const effects = new EffectExecutor(actions, ports.actionContext);
  const processor = new ControllerProcessor(repository, effects, ports.policy);
  const queue = new ControllerCommandQueue(processor);
  return { controller: new HarnessController(queue), repository, actions };
}
```

The CLI and Pi extension both call this root. No production singleton or hidden global may bypass injected storage, clock, process, runtime, Git, approval, or planning ports.

- [ ] **Step 4: Add crash and concurrency matrices**

```ts
for (const boundary of [
  "before-intent", "after-intent", "after-effect", "before-observation", "after-observation",
  "during-snapshot", "after-worker-result", "after-cherry-pick", "after-push", "after-pr-create",
] as const) {
  it(`recovers ${boundary} without duplicate effects`, async () => {
    const system = await crashableHarness(boundary);
    await system.crashAndRestart();
    expect(system.duplicateEffectKeys()).toEqual([]);
    expect(system.eventChainValid()).toBe(true);
  });
}
```

Race timer + Herdr + Pi + operator wakeups in every lifecycle state. Cover Devin unavailable → Codex implementation → Claude review, no reviewer, reviewer mutation, planning blocker, auth blocker, verification remediation, integration conflict, retry exhaustion, stale controller, and unknown non-retryable command result.

Run: `npm test -- test/e2e/fake-feature.test.ts test/e2e/crash-matrix.test.ts test/e2e/race-matrix.test.ts`.

Expected: PASS with no duplicate attempts/effects, skipped dependency, stale review, lost evidence, or invalid event chain.

- [ ] **Step 5: Commit**

```bash
git add src/composition-root.ts test/support/black-box-harness.ts test/support/fault-injector.ts test/e2e
git commit -m "test: prove durable black-box orchestration"
```

## Task 34: Package, Document, and Verify the Release

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`, `SECURITY.md`
- Create: `docs/installation.md`, `docs/workflow-dsl.md`, `docs/recovery.md`
- Create: `test/e2e/real-smoke.test.ts`, `test/integration/packed-package.test.ts`
- Modify: `package.json`, `package-lock.json`
- Create: `test/support/package-consumer.ts`

**Interfaces:**
- Produces `npm run verify`, an inspected npm tarball, and opt-in real compatibility/subscription suites.

- [ ] **Step 1: Write packed-package test**

```ts
it("installs the tarball and loads both public entrypoints", async () => {
  const packed = await packHarness();
  const consumer = await installPackedHarness(packed);
  await expect(consumer.exec("harness", ["--help"])).resolves.toMatchObject({ exitCode: 0 });
  await expect(consumer.loadWithPiResourceLoader()).resolves.toMatchObject({ errors: [] });
  expect(packed.files).not.toEqual(expect.arrayContaining([expect.stringMatching(/test|\.harness-output|events\.jsonl/)]));
});
```

- [ ] **Step 2: Run and observe release gaps**

Run: `npm run build && npm test -- test/integration/packed-package.test.ts`

Expected: FAIL until package files, executable mode, and runtime assets are correct.

- [ ] **Step 3: Add CI lanes and release scripts**

```json
{
  "scripts": {
    "verify": "npm run typecheck && vitest run && npm run build && npm pack --dry-run",
    "compat:herdr": "HARNESS_COMPAT_HERDR=1 vitest run test/integration/herdr/compat-smoke.test.ts",
    "compat:speckit": "HARNESS_COMPAT_SPECKIT=1 vitest run test/integration/speckit/preset.test.ts",
    "compat:pi": "HARNESS_COMPAT_PI=1 vitest run test/integration/pi-loader.test.ts"
  }
}
```

CI runs Node 22 unit/integration/fake-E2E, build, pack, and packed consumer tests. A separate environment with pinned Herdr/Spec Kit/Pi runs non-subscription compatibility on every release candidate. `HARNESS_E2E_REAL=1` remains manual and requires authenticated disposable worker accounts. PR creation additionally requires `HARNESS_E2E_GITHUB_REPO` naming a disposable repository.

- [ ] **Step 4: Document exact install, DSL, security, and recovery**

The README uses:

```bash
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness init
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness bootstrap --dry-run .
```

`installation.md` separates install approval, authentication, and run approval. `workflow-dsl.md` documents keyed fan-out, `same-item`, `all`, task projection, recovery classes, and complete YAML. `SECURITY.md` documents the built-in baseline, machine/project narrowing, protected paths, credential exclusion, and pre-approval read boundary. `recovery.md` documents lock-directory leases, fencing, torn-tail repair, interior corruption, indeterminate effects, and commands.

- [ ] **Step 5: Commit after final gates and package inspection**

Run:

```bash
npm run verify
npm pack --dry-run --json
```

Expected: zero test failures; successful TypeScript build; tarball contains only `dist/`, `bin/`, `presets/`, and `src/defaults/`; CLI and extension load from the installed tarball; no credentials, run state, tests, or `.harness-output/` are present.

```bash
git add .github/workflows/ci.yml README.md SECURITY.md docs/installation.md docs/workflow-dsl.md docs/recovery.md test/e2e/real-smoke.test.ts test/integration/packed-package.test.ts package.json package-lock.json
git commit -m "docs: package verified harness release"
```

Stop for final independent review. Do not publish until the review confirms spec coverage, event/effect invariants, clean-machine trust behavior, real compatibility evidence, and packed artifact contents.
