# Pi Orchestrator Phase 5: Bootstrap, Recovery, and Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Provision a clean machine from declarative locked inputs, operate and recover runs safely, then prove and package the release.

**Architecture:** A trusted exact-version external CLI reads only declarative harness files, inert Pi settings JSON, and Git metadata before approval. Effective trust is the intersection of its immutable embedded baseline, optional machine policy, project policy, and exact lock. The MVP trust root is the official package identity plus registry-verified tarball integrity; it does not claim an additional manifest-signature scheme. Pi packages are probed as data before approval and loaded only after an approved install. Operational recovery reuses the same fenced event/effect protocol as the resident controller.

**Tech Stack:** Node.js 22+, npm/package-manager probes, Git/GitHub/Herdr CLIs, TypeScript, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Task 29: Probe Capabilities and Compute Effective Trust

**Files:**
- Create: `src/install/types.ts`, `release-manifest.ts`, `baseline-policy.ts`, `policy.ts`, `probes.ts`, `pi-package-probe.ts`
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

it("reports a declared Pi package whose required extension is absent or disabled", async () => {
  const report = await probeEnvironment(piPackageFixture({ extension: "missing" }));
  expect(report.byId["pi-package:harness"]).toMatchObject({
    status: "missing",
    missingResources: ["dist/pi/extension.js"],
  });
});

it("blocks a repository-controlled Pi package-manager command", async () => {
  const report = await probeEnvironment(piPackageFixture({ projectNpmCommand: ["./owned"] }));
  expect(report.byId["pi-settings:npm-command"]).toMatchObject({ status: "policy_violation" });
});
```

- [ ] **Step 2: Run and observe missing install policy**

Run: `npm test -- test/unit/install/policy.test.ts test/integration/install/probes.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define exact release identities and policy intersection**

```ts
export interface TrustedSource {
  kind: "npm" | "git" | "formula" | "signed-artifact";
  identity: string;
  version: string;
  integrity: string;
}

export function effectivePolicy(baseline: TrustPolicy, machine: TrustPolicy | undefined, project: TrustPolicy): EffectivePolicy {
  const ceiling = machine ? applyMachineAmendments(baseline, machine) : baseline;
  return intersectPolicies(ceiling, project);
}
```

`release-manifest.json` contains exact identities and integrity-verification
rules for the harness, `@earendil-works/pi-coding-agent`, `typebox`, Spec Kit,
Superpowers, Herdr, four Herdr integrations, Codex CLI, Devin CLI, Claude Code,
Git, and GitHub CLI. The build freezes this manifest into the exact-version
package; the release job records the npm tarball `dist.integrity` alongside its
provenance evidence. Generated releases replace versions/digests atomically;
project files cannot alter the built-in manifest. A future detached signature
requires a separate design and is not implied by this MVP.

`environment.yaml.pi_packages` is the resource-level requirement. Every entry
references one `kind: pi-package` dependency in `harness.lock`; that lock entry
contains the exact Pi source string used for installation. The effective policy
authorizes the locked source, never a package name or path copied from project
settings.

- [ ] **Step 4: Implement shell-free fresh probes**

```ts
export async function probeExecutable(process: ProcessRunner, capability: Capability): Promise<ProbeResult> {
  const result = await process.run(capability.command, capability.versionArgs, { shell: false, timeoutMs: 10_000 });
  return result.exitCode === 0
    ? { id: capability.id, status: "present", version: capability.parseVersion(result.stdout) }
    : { id: capability.id, status: "missing", evidence: [result.stderr] };
}
```

Probe auth as status only; never return token values. Before approval, probe Pi
packages without invoking Pi: strictly parse the committed `.pi/settings.json`
as inert JSON, compare its project-local package source and exact resource
filters to the environment and lock, then read only expected package metadata
beneath Pi's documented project cache directories. Do not resolve symlinks
outside those directories, import extensions, parse skills as instructions,
start Pi, or run `pi list`; starting Pi could install missing project packages.
Report package installation and every declared extension/skill/prompt/theme
separately as `present`, `missing`, `disabled`, `wrong_source`, or
`unverifiable`; report a project settings package absent from the environment as
`unexpected`. Bound file sizes, entry counts, and traversal depth for every
metadata read. A project-local `npmCommand` or equivalent executable override is
a policy violation, never an installer input. Parse the machine Pi settings as
inert data too; a machine-level override is usable only when machine policy
separately allows its exact argv, and the effective command is displayed in the
plan.

Run: `npm test -- test/unit/install/policy.test.ts test/integration/install/probes.test.ts`.

Expected: PASS for no machine file, machine denial, separately approved machine source, project narrowing, missing binary, wrong version, missing auth, paths with spaces, missing Pi package, disabled required resource, unexpected package, wrong package source, project package-manager override, cache symlink escape, oversized metadata, and a proof that package code was not loaded.

- [ ] **Step 5: Commit**

```bash
git add src/install src/defaults/release-manifest.json test/unit/install test/integration/install/probes.test.ts
git commit -m "feat: define bootstrap trust and probes"
```

## Task 30: Build Install Plans, Typed Recipes, and Receipts

**Files:**
- Create: `src/install/plan.ts`, `recipes.ts`, `executor.ts`, `receipts.ts`, `pi-settings.ts`
- Modify: `test/support/install-fixtures.ts`
- Test: `test/integration/install/plan.test.ts`, `executor.test.ts`

**Interfaces:**
- Produces `createInstallPlan(lock, probes, policy)` and `executeInstallPlan(plan, approval)`.
- Recipes are exact-version npm, pinned Git commit with verified identity, allowlisted formula, signed artifact with digest, or manual.

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

it("uses the locked project-local Pi package recipe after approval", () => {
  const step = createInstallPlan(lockedPiPackage(), missingPiPackageProbe(), builtInPolicy()).steps[0];
  expect(step).toMatchObject({
    executable: "pi",
    argv: ["install", "-l", "npm:pi-multi-agent-harness@0.1.0"],
    expectedMutations: [".pi/settings.json", ".pi/npm/**"],
  });
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

Every automatic step records argv, cwd, source, integrity, scope, expected mutations, probe-after, rollback guidance, and any effective nested package-manager argv. A `pi-package` recipe verifies locked npm registry integrity or pinned Git commit identity immediately before invoking exactly `pi install -l <locked-source>` through `ProcessRunner` with `shell: false`; a project settings executable override is forbidden, and a machine-level override must be explicitly allowed by machine policy and bound into the approved plan hash. It then atomically merges the exact locked source and all four resource filters into project settings, using `[]` for undeclared types and preserving unrelated non-package settings. Conflicting customized or unexpected package entries block; `--repair` may repair a declared entry but never deletes a package the harness did not install. Local paths and floating Git refs are manual blockers. The plan explicitly warns that an approved Pi package can execute arbitrary extension/package-install code. `--yes` is accepted only for a plan whose automatic steps are all baseline/machine trusted and lock-matched.

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

The Pi-package post-probe first repeats the inert metadata/resource check, then
runs the installed Pi resource loader in a separate child process with a
sanitized environment, bounded timeout, project cwd, and no model turn. This
process boundary is for fault containment and is not a security sandbox. Success
requires the exact locked package identity and every declared filtered resource
to load without error. Failure leaves a partial receipt and blocks bootstrap;
it never broadens filters or substitutes a global package.

Run: `npm test -- test/integration/install/plan.test.ts test/integration/install/executor.test.ts`.

Expected: PASS for idempotency, partial failure, repair, checksum mismatch, manual step, disallowed source, and receipt redaction.

- [ ] **Step 5: Commit**

```bash
git add src/install/plan.ts src/install/recipes.ts src/install/executor.ts src/install/receipts.ts src/install/pi-settings.ts test/integration/install/plan.test.ts test/integration/install/executor.test.ts
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
- Before approval, allowed repository reads are `.harness/*.yaml`, `.harness/harness.lock`, `.pi/settings.json` as inert JSON, `.git` metadata, and the installed release manifest. Expected Pi cache metadata is read through a path-confined probe; no package code is loaded.

- [ ] **Step 1: Write malicious-repository trap test**

```ts
it("does not execute repository content before approval", async () => {
  const repo = await maliciousProjectFixture({
    packageLifecycleScript: "node -e \"require('fs').writeFileSync('owned','yes')\"",
    workflowArgv: ["node", "-e", "require('fs').writeFileSync('owned2','yes')"],
    piExtension: "require('fs').writeFileSync('pi-loaded','yes')",
  });
  await runHarness(["bootstrap", "--dry-run", repo]);
  expect(await exists(join(repo, "owned"))).toBe(false);
  expect(await exists(join(repo, "owned2"))).toBe(false);
  expect(await exists(join(repo, "pi-loaded"))).toBe(false);
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

Do not import repository modules, invoke package scripts, load `.pi` extensions, start Pi/Herdr, or execute workflow commands before plan-hash approval. Strictly parsing `.pi/settings.json` permits validation of desired project-local state but does not make any package trusted; only the release baseline/machine policy intersected with the lock can authorize its recipe.

- [ ] **Step 4: Implement machine-readable doctor**

`doctor --json` emits one schema-versioned report with capability ID, status, installed/required version, source, and redacted evidence. It freshly probes Node, Git, GitHub/auth/remote, Pi/planning profile, each declared Pi package and resource, Spec Kit/preset, Superpowers, Herdr/integrations, three workers, policies, config, and runtime directories; receipts are diagnostics only. A package installed globally when project-local scope is required, a disabled/filtered required resource, a source mismatch, or a loader error is not `present` and includes exact repair guidance.

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

Expected: PASS for clean-machine baseline, dry-run, approved project-local Pi package install, `--yes` denial, duplicate bootstrap, missing/disabled package resource repair, unknown package manual blocker, malicious files, missing auth, and JSON redaction.

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
  const agentName = stableAgentName("controller", repo.identity);
  const existing = await deps.herdr.findAgent({ name: agentName, workspaceId: workspace.id, paneId: workspace.rootPaneId });
  const agent = existing ?? await deps.herdr.startAgent({ name: agentName, kind: "pi", paneId: workspace.rootPaneId, cwd: repo.root });
  await deps.herdr.waitFor(agent.name, "idle");
  await deps.extensionProbe.assertReady(agent.name);
  return { mode: existing ? "reattached" : "started", agent };
}
```

- [ ] **Step 4: Implement explicit recovery and read-only views**

```ts
export async function recoverRun(run: RunRef, deps: RecoveryDependencies): Promise<RecoverySummary> {
  const lease = await RunLease.acquire(run.paths, deps.ownerId);
  try {
    const journal = await recoverJournal(run.paths, lease);
    let state = replay(journal.events);
    for (const intent of unobservedIntents(state)) {
      try {
        const output = await deps.effects.recover(intent);
        await deps.repository.append(effectObservedEvent(intent, output), lease);
      } catch (error) {
        await deps.repository.append(effectRecoveryFailedEvent(intent, error), lease);
      }
    }
    state = await deps.repository.reload();
    await deps.repository.snapshot(lease);
    return summarizeRecovery(state, { schedulingEnabled: false });
  } finally {
    await lease.release();
  }
}
```

`status`, `graph`, and `explain` validate then read state/events only. `recover`
first drains durable `controller.command_received` entries without a matching
processed boundary, then checks Herdr agents, worktrees, branches, commits,
results, push, and PR identities; an indeterminate non-retryable effect becomes
a blocker.

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
  expect(result.taskReviews.every((review) => review.worker !== review.implementationWorker)).toBe(true);
  expect(result.finalReviews).toMatchObject([{ reviewedCommit: result.pushedCommit, outcome: "approved" }]);
  expect(result.runBranchWasUnchangedDuringCandidateVerification).toBe(true);
  expect(result.pullRequests).toHaveLength(1);
  expect(result.pullRequests[0].headCommit).toBe(result.pushedCommit);
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
  "after-command-received", "after-command-decided", "after-first-decision-member",
  "before-intent", "after-intent", "after-effect", "before-observation", "after-observation",
  "after-herdr-prompt-send",
  "during-snapshot", "after-worker-result", "after-multi-commit-integration",
  "after-atomic-task-finalize", "after-final-review", "after-push", "after-pr-create",
] as const) {
  it(`recovers ${boundary} without duplicate effects`, async () => {
    const system = await crashableHarness(boundary);
    await system.crashAndRestart();
    expect(system.duplicateEffectKeys()).toEqual([]);
    expect(system.eventChainValid()).toBe(true);
  });
}
```

Race timer + Herdr + Pi + operator wakeups in every lifecycle state. Cover
an accepted operator retry recovered without resubmission, Devin unavailable →
Codex implementation → Claude review, a two-commit worker
result, no reviewer, reviewer mutation, planning crash before/after the native
terminal transcript and profile restoration, auth blocker, verification
remediation, wrong-parent candidate rejection, integration conflict,
task-status replay, final-review rejection, retry exhaustion, stale controller,
unknown non-retryable command result, clean-machine missing Pi package install,
and installed-but-disabled required Pi resource repair. The dry-run case must
prove no Pi package or resource code was loaded. The ambiguous Herdr prompt case
must either reconcile a matching structured result or block with evidence; it
must never send the assignment twice.

Run: `npm test -- test/e2e/fake-feature.test.ts test/e2e/crash-matrix.test.ts test/e2e/race-matrix.test.ts`.

Expected: PASS with no duplicate attempts/effects, skipped dependency, stale review, lost evidence, or invalid event chain.

- [ ] **Step 5: Commit**

```bash
git add src/composition-root.ts test/support/black-box-harness.ts test/support/fault-injector.ts test/e2e
git commit -m "test: prove durable black-box orchestration"
```

## Task 34: Package, Document, and Verify the Release

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md`, `SECURITY.md`
- Create: `docs/installation.md`, `docs/workflow-dsl.md`, `docs/recovery.md`, `docs/releasing.md`
- Create: `test/e2e/real-smoke.test.ts`, `test/integration/packed-package.test.ts`
- Modify: `package.json`, `package-lock.json`
- Create: `test/support/package-consumer.ts`

**Interfaces:**
- Produces `npm run verify`, an inspected npm tarball, and opt-in real compatibility/subscription suites.

- [ ] **Step 1: Write packed-package test**

```ts
it("installs the tarball and loads both public entrypoints", async () => {
  const packed = await packHarness();
  const consumer = await installPackedHarness(packed, { peers: releaseManifest().piPeers });
  await expect(consumer.exec("harness", ["--help"])).resolves.toMatchObject({ exitCode: 0 });
  await expect(consumer.loadWithPiResourceLoader()).resolves.toMatchObject({ errors: [] });
  expect(packed.files).not.toEqual(expect.arrayContaining([expect.stringMatching(/test|\.harness-output|events\.jsonl/)]));
});
```

- [ ] **Step 2: Run and observe release gaps**

Run: `npm run build && npm test -- test/integration/packed-package.test.ts`

Expected: FAIL until package files, executable mode, and runtime assets are correct.

`installPackedHarness` installs the exact Pi and TypeBox peer versions recorded
in the release manifest before installing the tarball; it must not let npm pick
an unrecorded moving peer version.

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

CI runs Node 22 unit/integration/fake-E2E, build, pack, and packed consumer
tests. A separate environment with pinned Herdr/Spec Kit/Pi runs
non-subscription compatibility on every release candidate.
`HARNESS_E2E_REAL=1` remains manual and requires authenticated disposable
worker accounts. PR creation additionally requires `HARNESS_E2E_GITHUB_REPO`
naming a disposable repository.

The tag-gated release workflow reruns every gate, verifies the npm actor is an
owner of `pi-multi-agent-harness`, publishes with `npm publish --provenance`,
then records `npm view pi-multi-agent-harness@$RELEASE_VERSION dist.integrity`
using the workflow's validated release-tag version in the
GitHub release evidence. First-time namespace reservation is an explicit human
precondition; the workflow never silently switches package names or scopes.

- [ ] **Step 4: Document exact install, DSL, security, and recovery**

The README uses:

```bash
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness init
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness bootstrap --dry-run .
```

`installation.md` separates install approval, authentication, and run approval.
`workflow-dsl.md` documents keyed fan-out, `same-item`, `all`, task projection,
recovery classes, and complete YAML. `SECURITY.md` documents the built-in
baseline, machine/project narrowing, protected paths, credential exclusion,
and pre-approval read boundary. `recovery.md` documents lock-directory leases,
fencing, torn-tail repair, interior corruption, indeterminate effects, and
commands. `releasing.md` documents namespace ownership, tag/version matching,
npm trusted publishing, provenance, and the external `dist.integrity` evidence.

- [ ] **Step 5: Commit after final gates and package inspection**

Run:

```bash
npm run verify
npm pack --dry-run --json
```

Expected: zero test failures; successful TypeScript build; the application payload is limited to `dist/`, `bin/`, `presets/`, and `src/defaults/` plus npm's required package metadata and README; CLI and extension load from the installed tarball; no credentials, run state, tests, source maps with embedded source, or `.harness-output/` are present.

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml README.md SECURITY.md docs/installation.md docs/workflow-dsl.md docs/recovery.md docs/releasing.md test/e2e/real-smoke.test.ts test/integration/packed-package.test.ts package.json package-lock.json
git commit -m "docs: package verified harness release"
```

Stop for final independent review. Do not publish until the review confirms spec coverage, event/effect invariants, clean-machine trust behavior, real compatibility evidence, and packed artifact contents.
