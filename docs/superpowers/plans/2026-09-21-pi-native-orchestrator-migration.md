# Pi-Native Orchestrator Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing Herdr execution layer with a profile-driven direct Pi runtime while preserving the green durable controller, Spec Kit, Git/worktree, verification, integration, and release behavior.

**Architecture:** A common `PiAttemptRuntime` launches every planner, implementer, and reviewer as an isolated Pi child process. Declarative profiles resolve provider/model/resources into exact launch specifications, while the existing durable action protocol persists identities, observes results, reconciles crashes, and owns completion. Managed profile roots prevent global Pi, provider, skill, plugin, and MCP leakage.

**Tech Stack:** Node.js `>=22.22.2`, TypeScript ESM, `@earendil-works/pi-coding-agent@0.86.1`, `@junghanacs/pi-shell-acp@0.11.1`, `@tian.zuo/pi-devin-acp@0.3.4`, TypeBox, Ajv, YAML, Vitest, fast-check, Spec Kit, Git CLI, GitHub CLI.

**Final release-scope amendment:** The install, ready workflow, and release
gate require only Codex CLI and Devin CLI. Claude-specific steps below record
earlier implementation exploration and are non-normative for this release.

**Spec:** `docs/superpowers/specs/2026-09-21-pi-native-multi-agent-orchestrator-design.md`

## Global Constraints

- Pi is the only harness-facing agent host and global orchestrator; provider inner loops receive one bounded assignment and no scheduling authority.
- Every planning, implementation, and review attempt launches through the shared Pi process seam.
- The global fallback family order is `codex`, `devin`; the shipped workflow explicitly prefers Devin for implementation and Codex for planning/review.
- Node.js `>=22.22.2`, Pi `0.86.1`, `@junghanacs/pi-shell-acp@0.11.1`, and `@tian.zuo/pi-devin-acp@0.3.4` are exact initial release versions.
- Worker discovery starts disabled and loads only resolved `--extension`, `--skill`, `--prompt-template`, and `--tools` values.
- Worker `HOME`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` always point into managed or attempt-owned paths.
- Setup never deletes or edits user-global Pi packages, Devin plugins, skills, MCP servers, or shell configuration.
- Provider authentication is interactive and machine-local; credentials never enter project files, events, evidence, logs, or command diagnostics.
- Superpowers is coding-worker discipline only. Delegation, global planning, parallel dispatch, worktree management, and branch-finishing skills are excluded from worker profiles.
- Workers may read but not modify sealed Spec Kit artifacts or harness configuration. Only controller-owned gates mark tasks `DONE`.
- Implementation worktrees are writable; review and verification worktrees are separate, detached, and pinned to the candidate commit.
- Production source, defaults, release manifests, scripts, tests, and docs contain no Herdr dependency after Task 8.
- Remote access, Tailscale, Pi Web, dashboards, multi-machine execution, and Windows service supervision are outside this plan.

## Review Focus

- A global Superpowers or provider skill/MCP server exists: the worker sees only declared resources. Covered by Tasks 2, 3, and 8.
- The controller dies after Pi spawn but before launch observation: recovery identifies the exact process/session and never launches a duplicate. Covered by Tasks 3, 5, and 8.
- An interrupted Devin ACP turn cannot resume the same native session: recovery preserves Git/transcript evidence and creates a new attempt instead of claiming continuation. Covered by Tasks 4, 5, and 8.
- A PID is reused after restart: cancellation and reattachment reject it unless start identity, executable, and attempt token all match. Covered by Tasks 3 and 5.
- A profile changes while a run is active: execution uses the frozen profile hash from `resolved-profiles.json`; changed source creates a new run revision. Covered by Tasks 1 and 5.
- Codex or Devin silently changes billing/auth mode: doctor marks the profile unavailable and routing uses only declared fallbacks. Covered by Tasks 2 and 7.
- A worker emits a terminal Pi event without a valid assignment-bound result: the attempt remains unaccepted and retries or blocks according to policy. Covered by Tasks 4 and 5.
- A provider process writes secrets to stderr: persisted diagnostics redact bearer tokens, credentials, userinfo, and configured secret names. Covered by Tasks 3 and 7.
- Independent tasks run concurrently: each launch receives a distinct worktree, profile/session directory, and process identity. Covered by Tasks 5 and 8.
- The packed package works while the source checkout is absent: clean-consumer `init`, setup plan, doctor, and fake E2E resolve only packaged assets. Covered by Tasks 7 and 8.

## File Map

New focused units:

- `src/contracts/profiles.ts` — closed wire schema for project profile documents.
- `src/config/profiles.ts` — resolve profiles, locked resources, tools, provider targets, and immutable hashes.
- `src/runtime/managed/paths.ts` — machine/profile/attempt managed path derivation.
- `src/runtime/managed/materialize.ts` — build allowlisted Pi and provider-native resource views.
- `src/runtime/managed/environment.ts` — construct the closed worker environment without ambient discovery variables.
- `src/runtime/pi-process/types.ts` — process/session records and supervisor port.
- `src/runtime/pi-process/events.ts` — parse and persist Pi JSON events and terminal boundaries.
- `src/runtime/pi-process/process.ts` — spawn, observe, reattach, interrupt, and terminate Pi processes.
- `src/runtime/pi-process/identity.ts` — verify PID/start/executable/attempt identity.
- `src/runtime/pi-worker/runtime.ts` — profile-neutral prepare/launch/recover/cancel/collect contract.
- `src/runtime/pi-worker/launch-spec.ts` — map a resolved profile to exact Pi argv and environment.
- `src/runtime/pi-worker/results.ts` — assignment-bound structured result collection.
- `src/runtime/production/pi-worker.ts` — bind coding assignments/worktrees to `PiWorkerRuntime`.
- `src/pi/child-planning-port.ts` — run Spec Kit planning stages through the same Pi process seam.
- `src/cli/auth.ts` — interactive authentication in a managed profile.
- `src/defaults/profiles.yaml` — immediately usable locked profile set.

Removed units:

- `src/runtime/herdr/client.ts`, `events.ts`, `identity.ts`, `protocol.generated.ts`, `runtime.ts`, `transport.ts`.
- `src/runtime/production/herdr-worker.ts`.
- `src/runtime/workers/codex.ts`, `devin.ts`, `claude.ts`, and Herdr-shaped `json-result-adapter.ts`.
- `test/integration/herdr/**`, `test/support/herdr-fixtures.ts`, and Herdr-specific contract/unit tests.

Existing units changed in place:

- Workflow/environment/lock schemas, routing, assignments, prompts, result schemas, production composition, planning actions, Pi events, CLI/bootstrap/doctor/init/start, defaults, release manifest, package scripts, E2E support, docs, and CI.

---

### Task 0: Preserve the Verified Pre-Pivot Baseline

**Files:**
- Commit existing modifications in the linked worktree `/Users/hauvo/.codex/worktrees/pi-orchestrator-implementation/harness`.
- Cherry-pick the approved spec commit from `main`. Execute this committed plan from its main-checkout path; its immutable commit is reported in the plan handoff and can be cherry-picked after the baseline is clean.

**Interfaces:**
- Consumes: current branch `feat/pi-multi-agent-orchestrator` at `9753e84` plus its known dirty recovery fixes.
- Produces: a clean, green branch whose history preserves pre-pivot work before migration.

- [ ] **Step 1: Verify the existing dirty baseline and record its manifest**

Run:

```bash
git status --short
git diff --check
npm test -- --run
```

Expected: the previously inspected recovery changes are present, `git diff --check` exits zero, and Vitest reports `336 passed | 4 skipped` before pivot edits.

- [ ] **Step 2: Commit the existing recovery fixes without rewriting them**

```bash
git add -u
git add src/runtime/production/cleanup-recovery.ts \
  test/unit/runtime/action-binders.test.ts \
  test/unit/runtime/durable-bound-action.test.ts \
  test/unit/runtime/run-approval.test.ts \
  test/unit/runtime/transcript-result.test.ts
git commit -m "fix: harden durable production recovery"
```

- [ ] **Step 3: Bring the approved Pi-native documentation onto the feature branch**

```bash
git cherry-pick 693d88a
```

Expected: the linked worktree is clean and contains the approved spec. The plan remains readable at `/Users/hauvo/Documents/1-active-projects/harness/docs/superpowers/plans/2026-09-21-pi-native-orchestrator-migration.md`; do not copy it with shell redirection into the feature worktree.

- [ ] **Step 4: Re-run the baseline gate**

```bash
npm run typecheck
npm test -- --run
```

Expected: PASS before the first migration test is added.

---

### Task 1: Define Profiles and Route Jobs by Profile Family

**Files:**
- Create: `src/contracts/profiles.ts`, `src/config/profiles.ts`, `src/defaults/profiles.yaml`.
- Modify: `src/contracts/index.ts`, `src/contracts/workflow.ts`, `src/contracts/environment.ts`, `src/contracts/lock.ts`, `src/config/load.ts`, `src/config/compile.ts`, `src/core/routing.ts`, `src/core/assignment.ts`, `src/core/review-policy.ts`, `src/defaults/workflow.yaml`, `src/defaults/workflows/*.yaml`.
- Test: `test/unit/contracts/profiles.test.ts`, `test/unit/config/profiles.test.ts`, `test/unit/core/routing.test.ts`, `test/unit/core/policy.test.ts`, `test/support/factories.ts`.

**Interfaces:**
- Consumes: locked dependency identities and the existing immutable workflow compiler.
- Produces: `ProfileDocument`, `ResolvedProfile`, `ResolvedProfiles`, `resolveProfiles()`, `profileId` and `profileFamily` assignment fields, and profile-aware review separation.

- [ ] **Step 1: Write failing closed-schema tests**

```ts
it("rejects undeclared profile fields and unsupported skill targets", () => {
  expect(() => validateProfiles({
    schema: "harness/profiles/v1",
    profiles: {
      bad: {
        family: "devin",
        runtime: "pi",
        provider: "devin",
        model: "devin/swe-2",
        role: "implementation",
        environment: "isolated",
        tools: ["read"],
        extensions: [],
        skills: [{ id: "superpowers:test-driven-development", targets: ["unknown"] }],
        context_files: false,
        prompt_templates: [],
        mcp: [],
      },
    },
  })).toThrow(/targets/);
});

it("freezes a profile hash and exact resource paths", () => {
  const resolved = resolveProfiles(profileFixture(), lockedResourcesFixture());
  expect(resolved.byId["implementer-devin"]).toMatchObject({
    id: "implementer-devin",
    family: "devin",
    provider: "devin",
    role: "implementation",
  });
  expect(resolved.byId["implementer-devin"]!.hash).toMatch(/^sha256:/);
  expect(Object.isFrozen(resolved.byId["implementer-devin"])).toBe(true);
});
```

- [ ] **Step 2: Run the focused tests and observe schema/resolver failure**

```bash
npx vitest run test/unit/contracts/profiles.test.ts test/unit/config/profiles.test.ts
```

Expected: FAIL because the profile contract and resolver do not exist.

- [ ] **Step 3: Implement the profile contract and canonical resolver**

```ts
export type ProfileFamily = "codex" | "devin" | "claude";
export type ProfileRole = "planning" | "implementation" | "review";
export type SkillTarget = "pi" | "provider";

export interface ResolvedProfile {
  readonly id: string;
  readonly family: ProfileFamily;
  readonly runtime: "pi";
  readonly provider: string;
  readonly model: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly role: ProfileRole;
  readonly tools: readonly string[];
  readonly extensions: readonly string[];
  readonly skills: readonly { id: string; path: string; targets: readonly SkillTarget[] }[];
  readonly promptTemplates: readonly string[];
  readonly contextFiles: false;
  readonly mcp: readonly never[];
  readonly hash: string;
}

export interface LockedProfileResources {
  readonly extensions: Readonly<Record<string, string>>;
  readonly skills: Readonly<Record<string, string>>;
  readonly promptTemplates: Readonly<Record<string, string>>;
}

export interface ResolvedProfiles {
  readonly byId: Readonly<Record<string, ResolvedProfile>>;
  readonly hash: string;
}

export function resolveProfiles(
  document: ProfileDocument,
  resources: LockedProfileResources,
): ResolvedProfiles;
```

Canonicalize sorted set fields, preserve declared fallback order, reject missing lock entries, reject duplicate IDs/targets, and reject `provider` skill targets for families without a projection implementation.

- [ ] **Step 4: Replace worker-kind routing with profile-aware routing**

```ts
export interface RouteCandidate {
  readonly profileId: string;
  readonly family: ProfileFamily;
  readonly available: boolean;
}

export function selectProfile(
  preference: readonly string[],
  candidates: Readonly<Record<string, RouteCandidate>>,
  excludeFamily?: ProfileFamily,
): RouteCandidate;
```

`WorkerAssignment` carries both `profileId` and `profileFamily`. Review policy compares families, not profile IDs, so `reviewer-codex` cannot review `implementer-codex` under the independent-review rule.

- [ ] **Step 5: Add profile drift and fallback tests**

```ts
it("keeps a frozen active-run profile after source config changes", () => {
  const run = compileRun({ profiles: resolvedProfilesFixture() });
  const edited = resolveProfiles(profileFixture({ model: "changed" }), lockedResourcesFixture());
  expect(run.resolvedProfilesHash).not.toBe(edited.hash);
  expect(run.profiles.byId["planner-codex"]!.model).toBe("openai-codex/gpt-5.6-luna");
});

it("falls back by declared profile order without crossing review family", () => {
  expect(selectReviewProfile(
    ["reviewer-codex", "reviewer-claude", "reviewer-devin"],
    availability({ "reviewer-codex": false }),
    "devin",
  ).profileId).toBe("reviewer-claude");
});
```

- [ ] **Step 6: Run profile, compiler, routing, and assignment suites**

```bash
npx vitest run test/unit/contracts test/unit/config test/unit/core/routing.test.ts test/unit/core/policy.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/contracts src/config src/core src/defaults test/unit test/support/factories.ts
git commit -m "feat: resolve immutable Pi worker profiles"
```

---

### Task 2: Build the Isolated Managed Runtime

**Files:**
- Create: `src/runtime/managed/paths.ts`, `src/runtime/managed/environment.ts`, `src/runtime/managed/materialize.ts`, `src/runtime/managed/redaction.ts`.
- Modify: `src/install/types.ts`, `src/install/plan.ts`, `src/install/recipes.ts`, `src/install/probes.ts`, `src/install/executor.ts`, `src/install/receipts.ts`, `src/cli/bootstrap.ts`, `src/cli/doctor.ts`, `src/defaults/harness.lock`, `src/defaults/release-manifest.json`, `package.json`.
- Test: `test/unit/runtime/managed-paths.test.ts`, `test/unit/runtime/managed-environment.test.ts`, `test/integration/install/managed-runtime.test.ts`, `test/integration/doctor.test.ts`, `test/integration/bootstrap.test.ts`, `test/support/install-fixtures.ts`.

**Interfaces:**
- Consumes: `ResolvedProfile`, effective trust policy, locked sources, and install receipts.
- Produces: `ManagedRuntimePaths`, `ManagedProfileView`, `materializeProfile()`, `buildManagedEnvironment()`, exact provider package probes, and Node floor diagnostics.

- [ ] **Step 1: Write failing isolation and global-preservation tests**

```ts
it("constructs a closed managed environment", () => {
  const env = buildManagedEnvironment({
    profile: resolvedProfileFixture("implementer-devin"),
    paths: managedPathsFixture(),
    ambient: {
      HOME: "/Users/example",
      XDG_CONFIG_HOME: "/Users/example/.config",
      ANTHROPIC_API_KEY: "must-not-leak",
      SAFE_PROXY: "allowed",
    },
    forwardedKeys: ["SAFE_PROXY"],
  });
  expect(env.HOME).toMatch(/pi-harness/);
  expect(env.PI_CODING_AGENT_DIR).toMatch(/profiles\/implementer-devin\/pi-agent/);
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.SAFE_PROXY).toBe("allowed");
});

it("does not mutate the user Pi or Devin estate", async () => {
  const before = await hashTree(userEstate.path);
  await materializeProfile(profile, fixture.paths);
  expect(await hashTree(userEstate.path)).toBe(before);
});
```

- [ ] **Step 2: Run and observe missing managed runtime**

```bash
npx vitest run test/unit/runtime/managed-paths.test.ts test/unit/runtime/managed-environment.test.ts test/integration/install/managed-runtime.test.ts
```

Expected: FAIL because managed runtime modules do not exist.

- [ ] **Step 3: Implement deterministic path and environment construction**

```ts
export interface ManagedRuntimePaths {
  readonly root: string;
  readonly packages: string;
  readonly skills: string;
  readonly profileHome: string;
  readonly piAgentDir: string;
  readonly xdgConfigHome: string;
  readonly xdgDataHome: string;
}

export interface ManagedEnvironmentInput {
  readonly profile: ResolvedProfile;
  readonly paths: ManagedRuntimePaths;
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly forwardedKeys: readonly string[];
  readonly executablePath: string;
}

export function managedRuntimePaths(input: {
  dataHome: string;
  runtimeVersion: string;
  profileId: string;
}): ManagedRuntimePaths;

export function buildManagedEnvironment(input: ManagedEnvironmentInput): Readonly<Record<string, string>>;
```

Reject traversal and separators in profile/runtime IDs. Start from an empty map, add only harness-owned roots, an explicit `PATH`, locale, terminal basics, and policy-forwarded keys. Redact bearer tokens, credential assignments, URL userinfo, and configured secret names before any diagnostic write.

- [ ] **Step 4: Materialize exact Pi and provider targets**

```ts
export interface ManagedProfileView {
  readonly extensionPaths: readonly string[];
  readonly piSkillPaths: readonly string[];
  readonly providerSkillPaths: readonly string[];
  readonly promptTemplatePaths: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly receiptHash: string;
}

export async function materializeProfile(
  profile: ResolvedProfile,
  paths: ManagedRuntimePaths,
): Promise<ManagedProfileView>;
```

For Devin, create only selected entries under managed `.agents/skills`. For Claude bridge, write a closed `claude-bridge.json` with `strictMcpConfig: true`, `askClaude.enabled: false`, `autoMemoryEnabled: false`, and no MCP entries. Use atomic directory replacement and content hashes; never symlink a user-global resource.

- [ ] **Step 5: Replace Herdr locks with Pi provider locks and enforce Node floor**

The release manifest and default lock must contain exact trusted entries for Pi, Devin ACP, Claude bridge, Superpowers, Spec Kit, Git, and GitHub CLI. Remove Herdr and its integrations. Add a Node probe that parses semver and reports `wrong_version` for `22.19.0` against `>=22.22.2`.

```ts
expect(probeNodeVersion("v22.19.0")).toEqual({
  id: "node",
  status: "wrong_version",
  version: "22.19.0",
  required: ">=22.22.2",
});
```

- [ ] **Step 6: Run installer and isolation suites**

```bash
npx vitest run test/unit/runtime test/integration/install test/integration/bootstrap.test.ts test/integration/doctor.test.ts
npm run typecheck
```

Expected: PASS, including proof that fixture-global packages/skills/MCP do not appear in the managed view.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/managed src/install src/cli/bootstrap.ts src/cli/doctor.ts src/defaults package.json test/unit/runtime test/integration/install test/integration/bootstrap.test.ts test/integration/doctor.test.ts test/support/install-fixtures.ts
git commit -m "feat: isolate managed Pi worker runtimes"
```

---

### Task 3: Implement the Durable Pi Child-Process Transport

**Files:**
- Create: `src/runtime/pi-process/types.ts`, `src/runtime/pi-process/identity.ts`, `src/runtime/pi-process/events.ts`, `src/runtime/pi-process/process.ts`.
- Modify: `src/actions/types.ts`, `src/actions/executor.ts`, `src/runtime/production/records.ts`, `src/runtime/production/cleanup-recovery.ts`.
- Test: `test/unit/runtime/pi-process-identity.test.ts`, `test/unit/runtime/pi-events.test.ts`, `test/integration/pi-process/runtime.test.ts`, `test/integration/pi-process/cancellation.test.ts`, `test/support/pi-process-fixtures.ts`.

**Interfaces:**
- Consumes: shell-free process execution policy, attempt-owned directories, and redaction from Task 2.
- Produces: `PiProcessSupervisor`, `PiProcessRecord`, `PiProcessObservation`, `launchPiProcess()`, event parser, exact identity checks, and safe cancellation.

- [ ] **Step 1: Write failing event-boundary and PID-reuse tests**

```ts
it("accepts one terminal assistant result after agent_settled", () => {
  const state = reducePiEvents([
    piEvent("message_end", { role: "assistant", content: resultEnvelope() }),
    piEvent("turn_end", { stopReason: "stop" }),
    piEvent("agent_settled", {}),
  ]);
  expect(state.terminal).toMatchObject({ settled: true, acceptedStopReason: true });
});

it("refuses to signal a reused pid", async () => {
  const supervisor = supervisorFixture({
    observed: { pid: 42, startIdentity: "new", executable: "/usr/bin/other" },
  });
  await expect(supervisor.cancel(processRecord({
    pid: 42,
    startIdentity: "old",
    executable: "/managed/bin/pi",
  }))).rejects.toThrow(/identity mismatch/);
  expect(supervisor.signals).toEqual([]);
});
```

- [ ] **Step 2: Run and observe missing transport**

```bash
npx vitest run test/unit/runtime/pi-process-identity.test.ts test/unit/runtime/pi-events.test.ts test/integration/pi-process
```

Expected: FAIL because the Pi process modules do not exist.

- [ ] **Step 3: Define the process supervisor port and persisted record**

```ts
export interface PiProcessRecord {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly attemptToken: string;
  readonly executable: string;
  readonly argvHash: string;
  readonly cwd: string;
  readonly pid: number;
  readonly startIdentity: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly eventsPath: string;
  readonly stderrPath: string;
  readonly startedAt: string;
}

export interface PiLaunchSpec {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly stdin?: Uint8Array;
}

export type PiProcessObservation =
  | { readonly status: "running"; readonly record: PiProcessRecord }
  | { readonly status: "exited"; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly status: "missing" }
  | { readonly status: "identity_mismatch"; readonly evidence: readonly string[] };

export interface PiProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly terminal: PiTerminalBoundary;
}

export interface CancellationEvidence {
  readonly attemptId: string;
  readonly signals: readonly string[];
  readonly exit: PiProcessExit | null;
}

export interface PiProcessSupervisor {
  launch(spec: PiLaunchSpec): Promise<PiProcessRecord>;
  observe(record: PiProcessRecord): Promise<PiProcessObservation>;
  wait(record: PiProcessRecord, signal: AbortSignal): Promise<PiProcessExit>;
  cancel(record: PiProcessRecord, graceMs: number): Promise<CancellationEvidence>;
}
```

`launch` opens append-only event/stderr files, spawns with `shell: false`, records start identity, fsyncs the process record, then releases the child to run. The attempt token appears in both environment and session metadata.

- [ ] **Step 4: Implement incremental Pi JSON event parsing**

Parse newline-delimited JSON without treating a torn final line as a complete event. Preserve raw event hashes, assistant content, tool completion, `turn_end`, `agent_settled`, extension custom records, and process exit. Unknown event types are stored but cannot satisfy a terminal boundary.

```ts
export type PiTerminalBoundary = Readonly<{
  settled: boolean;
  acceptedStopReason: boolean;
  completeToolResults: boolean;
  finalAssistantText?: string;
  providerSession?: { source: string; id: string };
}>;
```

- [ ] **Step 5: Implement observation, reattachment, and cancellation**

On macOS/Linux derive start identity from the live process plus executable and attempt token. Reattach only when every identity field matches. Cancellation sends `SIGINT`, waits the configured grace, sends `SIGTERM`, then `SIGKILL` only to the still-matching process tree. Record every signal and observed exit.

- [ ] **Step 6: Add secret-redaction and crash-boundary tests**

```ts
it("redacts stderr before persistence", async () => {
  await fixture.emitStderr("Authorization=secret Bearer abc https://u:p@example.test");
  expect(await fixture.readPersistedStderr()).toBe(
    "Authorization=[REDACTED] Bearer [REDACTED] https://[REDACTED]@example.test",
  );
});

it("reattaches after crash without a second spawn", async () => {
  const recovered = await runtime.recover(preparedAttempt(), recordForLiveProcess());
  expect(recovered.status).toBe("running");
  expect(supervisor.launchCalls).toHaveLength(0);
});
```

- [ ] **Step 7: Run transport tests and commit**

```bash
npx vitest run test/unit/runtime/pi-process-identity.test.ts test/unit/runtime/pi-events.test.ts test/integration/pi-process
npm run typecheck
git add src/runtime/pi-process src/actions src/runtime/production/records.ts src/runtime/production/cleanup-recovery.ts test/unit/runtime test/integration/pi-process test/support/pi-process-fixtures.ts
git commit -m "feat: supervise durable Pi worker processes"
```

---

### Task 4: Implement the Profile-Neutral PiWorkerRuntime

**Files:**
- Create: `src/runtime/pi-worker/launch-spec.ts`, `src/runtime/pi-worker/results.ts`, `src/runtime/pi-worker/runtime.ts`, `src/runtime/pi-worker/index.ts`.
- Modify: `src/runtime/workers/types.ts`, `src/runtime/workers/prompt.ts`, `src/runtime/workers/result.ts`, `src/runtime/workers/superpowers-profile.ts`, `src/contracts/worker-result.ts`.
- Remove: `src/runtime/workers/codex.ts`, `src/runtime/workers/devin.ts`, `src/runtime/workers/claude.ts`, `src/runtime/workers/json-result-adapter.ts`.
- Test: `test/contract/pi-worker-runtime.test.ts`, `test/unit/runtime/pi-launch-spec.test.ts`, `test/unit/runtime/pi-worker-results.test.ts`, `test/integration/pi-worker/profiles.test.ts`, `test/support/worker-fixtures.ts`.

**Interfaces:**
- Consumes: resolved profiles, managed profile views, Pi process supervisor, existing assignments, and worker-result validator.
- Produces: one `PiWorkerRuntime` for Codex, Devin, and Claude; exact argv; role-bound result collection; provider capability probes.

- [ ] **Step 1: Write the shared three-family contract test**

```ts
for (const fixture of [codexProfile(), devinProfile(), claudeProfile()]) {
  it(`runs ${fixture.profile.family} through Pi`, async () => {
    const prepared = await fixture.runtime.prepare(fixture.assignment);
    const handle = await fixture.runtime.launch(prepared);
    fixture.supervisor.complete(handle.process, terminalEvents(fixture.result));
    await expect(fixture.runtime.collect(prepared)).resolves.toEqual(fixture.result);
    expect(fixture.supervisor.lastSpec.executable).toBe(fixture.managedPiExecutable);
    expect(fixture.supervisor.lastSpec.argv).toContain("--mode");
    expect(fixture.supervisor.lastSpec.argv).toContain("json");
  });
}
```

- [ ] **Step 2: Run and observe the Herdr-shaped adapter failure**

```bash
npx vitest run test/contract/pi-worker-runtime.test.ts test/unit/runtime/pi-launch-spec.test.ts test/unit/runtime/pi-worker-results.test.ts
```

Expected: FAIL because the direct runtime and profile launch spec do not exist.

- [ ] **Step 3: Build exact Pi launch specifications**

```ts
export interface PiLaunchSpec {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly stdin?: Uint8Array;
}
```

Every argv starts with `--mode json --print --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes`. Append exact provider, model, thinking, tool allowlist, explicit resource paths, session ID/directory, and prompt. Never use `shell`, ambient package discovery, or user-global settings.

- [ ] **Step 4: Implement the runtime contract**

```ts
export interface PiWorkerRuntime {
  probe(profile: ResolvedProfile): Promise<ProfileCapabilities>;
  prepare(assignment: WorkerAssignment): Promise<PreparedPiAttempt>;
  launch(prepared: PreparedPiAttempt): Promise<PiWorkerHandle>;
  observe(handle: PiWorkerHandle): Promise<PiWorkerObservation>;
  recover(prepared: PreparedPiAttempt, record: AttemptRecord): Promise<RecoveryDecision>;
  cancel(handle: PiWorkerHandle): Promise<CancellationEvidence>;
  collect(prepared: PreparedPiAttempt): Promise<ParsedWorkerResult>;
}

export interface PreparedPiAttempt {
  readonly assignment: WorkerAssignment;
  readonly profile: ResolvedProfile;
  readonly launch: PiLaunchSpec;
  readonly prompt: string;
  readonly resultPath: string;
}

export interface PiWorkerHandle {
  readonly attemptId: string;
  readonly process: PiProcessRecord;
}

export type PiWorkerObservation = PiProcessObservation;

export interface ProfileCapabilities {
  readonly available: boolean;
  readonly providerRegistered: boolean;
  readonly modelAvailable: boolean;
  readonly authenticated: boolean;
  readonly resourcesVerified: boolean;
  readonly evidence: readonly string[];
}

export type ParsedWorkerResult =
  | { readonly status: "valid"; readonly result: WorkerResult }
  | { readonly status: "invalid"; readonly reason: string };

export type RecoveryDecision =
  | { readonly status: "running"; readonly handle: PiWorkerHandle }
  | { readonly status: "observed"; readonly result: WorkerResult }
  | { readonly status: "resume"; readonly sessionId: string }
  | { readonly status: "retry"; readonly reason: string }
  | { readonly status: "indeterminate"; readonly evidence: readonly string[] };

export interface AttemptRecord {
  readonly attemptId: string;
  readonly process?: PiProcessRecord;
  readonly providerSession?: { readonly source: string; readonly id: string };
}
```

Preparation stages `.harness-output/assignment.md`, resolves the frozen profile hash, and records the expected result schema. Review rejects the implementation family. Probe checks Pi version, provider registration, model availability, auth readiness, resource hashes, and provider-specific strict-mode settings without returning credentials.

- [ ] **Step 5: Implement structured result collection and recovery decisions**

Accept a file result or a terminal assistant JSON envelope only when schema version, assignment hash, role, candidate commit, and terminal boundary all match. For completed sessions return `observed`; for a matching live process return `running`; for a proven resumable exact session return `resume`; for interrupted non-resumable Devin return `retry`; for ambiguous evidence return `indeterminate`.

```ts
expect(recoverInterruptedDevin({
  piSessionId: "333",
  priorProviderSessionId: "dorian-tangerine",
  loadedProviderSessionId: "brook-fruit",
})).toEqual({
  status: "retry",
  reason: "provider session identity changed",
});
```

- [ ] **Step 6: Prove Superpowers/resource behavior per provider**

Codex receives explicit Pi skill paths. Devin additionally sees only projected managed `.agents/skills`. Claude bridge receives a strict config and forwarded selected skill block with AskClaude disabled. A fixture global skill named `forbidden-global-skill` must be absent from all three captured startup contexts.

- [ ] **Step 7: Run contract/integration tests and commit**

```bash
npx vitest run test/contract/pi-worker-runtime.test.ts test/unit/runtime/pi-launch-spec.test.ts test/unit/runtime/pi-worker-results.test.ts test/integration/pi-worker
npm run typecheck
git add src/runtime/pi-worker src/runtime/workers src/contracts/worker-result.ts test/contract test/unit/runtime test/integration/pi-worker test/support/worker-fixtures.ts
git commit -m "feat: run every coding worker through Pi profiles"
```

---

### Task 5: Replace Herdr in the Durable Production Composition

**Files:**
- Create: `src/runtime/production/pi-worker.ts`, `test/support/pi-worker-fixtures.ts`.
- Modify: `src/runtime/production/worker-action.ts`, `worker-attempts.ts`, `action-binders.ts`, `action-registry.ts`, `system.ts`, `records.ts`, `src/durable-composition-root.ts`, `src/controller/reconcile-run.ts`, `src/contracts/controller-command.ts`, `src/pi/events.ts`, `src/core/workflow-lifecycle.ts`.
- Remove: `src/runtime/production/herdr-worker.ts`, `src/runtime/herdr/**`, `test/support/herdr-fixtures.ts`, `test/unit/runtime/herdr-production-worker.test.ts`, `test/integration/herdr/**`, `test/integration/herdr/worker-adapters.test.ts`.
- Test: `test/unit/runtime/pi-production-worker.test.ts`, `test/unit/runtime/durable-worker-action.test.ts`, `test/integration/production/system.test.ts`, `test/integration/durable-composition-root.test.ts`, `test/integration/controller-race.test.ts`, `test/e2e/production-pipeline.test.ts`.

**Interfaces:**
- Consumes: `PiWorkerRuntime`, existing `ProductionWorkerAttemptPort`, durable records, controller queue, worktree bindings, and effect executor.
- Produces: `ProductionPiWorkerRuntime`, process event source, reconcilable worker launch, crash-safe cleanup, and a Herdr-free production composition root.

- [ ] **Step 1: Replace Herdr fixture expectations with Pi process expectations**

```ts
it("records one launch across execute/recovery races", async () => {
  const fixture = piProductionFixture({ crashAfterSpawn: true });
  await expect(fixture.action.execute(fixture.context, fixture.intent)).rejects.toThrow();
  await Promise.all([
    fixture.action.reconcile(fixture.recoveryContext, fixture.intent),
    fixture.controller.enqueue(recoverCommand(fixture.intent.idempotencyKey)),
  ]);
  expect(fixture.supervisor.launchCalls).toHaveLength(1);
});
```

- [ ] **Step 2: Run the production subset and observe Herdr dependencies**

```bash
npx vitest run test/unit/runtime/pi-production-worker.test.ts test/unit/runtime/durable-worker-action.test.ts test/integration/production/system.test.ts test/integration/durable-composition-root.test.ts
```

Expected: FAIL until `ProductionPiWorkerRuntime` is bound.

- [ ] **Step 3: Bind attempts to profiles, processes, and worktrees**

```ts
export interface PersistedPreparedPiAttempt {
  readonly schemaVersion: 1;
  readonly assignment: WorkerAssignment;
  readonly binding: LifecycleWorktreeBinding;
  readonly profile: { id: string; family: ProfileFamily; hash: string };
  readonly prompt: string;
  readonly resultPath: string;
  readonly attemptId: string;
  readonly launch: PiLaunchSpec;
  readonly process?: PiProcessRecord;
}
```

Validate assignment/profile/worktree/hash identity on every load. Persist the process record immediately after launch. `afterCompleted` releases the worktree only after result acceptance; `abort` cancels a matching process then quarantines or releases according to Git state.

- [ ] **Step 4: Make durable worker effects reconcilable**

Change `DurableWorkerAction.recovery()` to `reconcilable`. Recovery consults the persisted prepared/process record and returns `not_found`, `observed`, or `indeterminate`; it never calls launch from the reconcile path. A runtime `retry` decision becomes a normal failed/interrupted attempt event so scheduler policy creates a new generation.

- [ ] **Step 5: Replace runtime event source and remove Herdr production code**

`ControllerCommand.source` becomes `"timer" | "process" | "pi" | "operator" | "recovery"`. `PiEventBridge.process()` enqueues normalized process events. Delete Herdr transports, protocol, actions, fixtures, scripts, package commands, and compatibility gates. Update lifecycle diagnostics to refer to Pi attempt/process evidence.

- [ ] **Step 6: Add parallel-worktree and cancellation race tests**

```ts
it("runs independent jobs in distinct process and worktree identities", async () => {
  const [left, right] = await fixture.startReady(["T001", "T004"]);
  expect(left.binding.path).not.toBe(right.binding.path);
  expect(left.process.sessionDir).not.toBe(right.process.sessionDir);
  expect(left.process.attemptToken).not.toBe(right.process.attemptToken);
});
```

Also race result completion with cancellation and assert one terminal observation, one cleanup, and no signal after an accepted completion.

- [ ] **Step 7: Run production/crash suites and assert Herdr removal**

```bash
npx vitest run test/unit/runtime test/integration/production test/integration/durable-composition-root.test.ts test/integration/controller-race.test.ts test/e2e/production-pipeline.test.ts
! rg -i "herdr" src package.json scripts --glob '!**/*.map'
npm run typecheck
```

Expected: PASS and the search exits zero because it finds no production Herdr reference.

- [ ] **Step 8: Commit**

```bash
git add -A src test package.json scripts
git commit -m "feat: replace Herdr with durable Pi execution"
```

---

### Task 6: Run Spec Kit Planning Through the Shared Pi Seam

**Files:**
- Create: `src/pi/child-planning-port.ts`, `test/support/pi-planning-fixtures.ts`.
- Modify: `src/ports/planning.ts`, `src/pi/planning-port.ts`, `src/pi/planning-agent.ts`, `src/pi/planning-profile.ts`, `src/pi/planning-profile-port.ts`, `src/pi/events.ts`, `src/runtime/production/planning-action.ts`, `src/speckit/planning-action.ts`, `src/speckit/artifacts.ts`, `src/runtime/production/system.ts`.
- Test: `test/unit/pi-planning-port.test.ts`, `test/integration/speckit/planning-action.test.ts`, `test/integration/pi-residency.test.ts`, `test/integration/production/system.test.ts`.

**Interfaces:**
- Consumes: `PiAttemptRuntime`, `planner-codex` resolved profile, Spec Kit prompt/preset, artifact hash baseline, and existing deterministic task-graph sealing.
- Produces: `ChildPiPlanningPort`, durable planning attempt receipt, correlated terminal transcript proof, and planning through the same managed process/runtime as coding workers.

- [ ] **Step 1: Write a failing child-planning contract test**

```ts
it("runs a planning generation through planner-codex and accepts only new artifacts", async () => {
  const receipt = await fixture.port.run({
    stage: "tasks",
    correlationId: "plan-F023-3",
    generation: 1,
    prompt: fixture.specKitTasksPrompt,
    expectedArtifacts: ["spec.md", "plan.md", "tasks.md"],
    before: fixture.beforeHashes,
  });
  expect(fixture.lastLaunch.profileId).toBe("planner-codex");
  expect(receipt.terminal.settled).toBe(true);
  expect(receipt.afterHashes["tasks.md"]).not.toBe(fixture.beforeHashes["tasks.md"]);
});
```

- [ ] **Step 2: Run and observe use of the resident interactive planning turn**

```bash
npx vitest run test/unit/pi-planning-port.test.ts test/integration/speckit/planning-action.test.ts
```

Expected: FAIL until planning is routed through the managed child Pi seam.

- [ ] **Step 3: Implement `ChildPiPlanningPort`**

Use the same launch/session/event/process types from Tasks 3–4. The planning prompt carries a correlation marker and stage contract. Accept only a settled terminal turn with complete tools and the exact artifact delta. Store session ID/path, profile hash, correlation/generation, terminal event hash, and before/after artifact hashes.

```ts
export interface PlanningAttemptReceipt {
  readonly profileId: "planner-codex" | string;
  readonly profileHash: string;
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly correlationId: string;
  readonly generation: number;
  readonly terminalEventHash: string;
  readonly beforeHashes: Readonly<Record<string, string | null>>;
  readonly afterHashes: Readonly<Record<string, string>>;
}
```

- [ ] **Step 4: Preserve deterministic Spec Kit validation**

Immediately after a tasks generation settles, parse visible tasks and the metadata envelope, validate requirements/acceptance references, generate `task-graph.json`, and seal semantic hashes. Intermediate, aborted, unrelated, or artifact-free turns remain pending or blocked and never accept stale files.

- [ ] **Step 5: Add crash recovery tests**

Cover crash after artifact write before terminal event, after terminal event before receipt, and after receipt before action observation. Only the terminal-correlated case recovers once; other cases start a new generation or block without reusing stale artifacts.

- [ ] **Step 6: Run planning and system suites, then commit**

```bash
npx vitest run test/unit/pi-planning-port.test.ts test/integration/speckit test/integration/pi-residency.test.ts test/integration/production/system.test.ts
npm run typecheck
git add src/pi src/ports/planning.ts src/runtime/production src/speckit test/unit/pi-planning-port.test.ts test/integration/speckit test/integration/pi-residency.test.ts test/integration/production/system.test.ts test/support/pi-planning-fixtures.ts
git commit -m "feat: run Spec Kit planning through managed Pi"
```

---

### Task 7: Ship Ready-to-Use Setup, Auth, Doctor, and Workflow Assets

**Files:**
- Create: `src/cli/auth.ts`.
- Modify: `src/cli/main.ts`, `init.ts`, `start.ts`, `recover.ts`, `bootstrap.ts`, `doctor.ts`, `trusted-project-reader.ts`, `src/pi/commands.ts`, `src/pi/dependencies.ts`, `src/pi/extension.ts`, `src/defaults/environment.yaml`, `profiles.yaml`, `workflow.yaml`, `workflows/*.yaml`, `harness.lock`, `release-manifest.json`, `package.json`, `bin/harness.mjs`.
- Test: `test/integration/init.test.ts`, `bootstrap.test.ts`, `doctor.test.ts`, `operations.test.ts`, `recover-cli.test.ts`, `pi-loader.test.ts`, `test/unit/pi-commands.test.ts`, `test/integration/packed-package.test.ts`.

**Interfaces:**
- Consumes: managed runtime/setup, resolved profiles, provider probes, production composition, and packaged default assets.
- Produces: `harness setup`, `harness auth <profile>`, profile-aware doctor, direct Pi `start/recover`, ready workflow DSL, and packaged clean-project behavior.

- [ ] **Step 1: Update init and doctor tests for the Pi-native asset set**

```ts
it("initializes an immediately usable Pi-native workflow", async () => {
  await runHarness(project, ["init"]);
  expect(await yaml(".harness/profiles.yaml")).toMatchObject({
    schema: "harness/profiles/v1",
    profiles: {
      "planner-codex": { provider: "openai-codex" },
      "implementer-devin": { provider: "devin" },
      "reviewer-claude": { provider: "claude-bridge" },
    },
  });
  expect(await text(".harness/harness.lock")).not.toMatch(/herdr/i);
});
```

- [ ] **Step 2: Run CLI/package tests and observe old Herdr requirements**

```bash
npx vitest run test/integration/init.test.ts test/integration/bootstrap.test.ts test/integration/doctor.test.ts test/integration/operations.test.ts test/integration/packed-package.test.ts
```

Expected: FAIL until defaults, lock, doctor, and operations use profiles/direct Pi.

- [ ] **Step 3: Add `setup` and managed-profile authentication commands**

`setup` is the user-facing alias for the approved bootstrap flow and retains `bootstrap` as a compatibility alias for one release. `auth` resolves one profile, constructs its managed environment, and uses shell-free interactive spawn:

```ts
export interface ProfileAuthCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function authCommand(profile: ResolvedProfile): ProfileAuthCommand;
```

Codex opens Pi authentication for `openai-codex`; Devin invokes the native Devin login/ACP readiness flow; Claude invokes Claude Code login through the managed HOME. The command never captures or prints a credential.

- [ ] **Step 4: Make doctor profile-aware and billing-safe**

Doctor reports Node floor, Pi/version/model, locked extension integrity, managed resource hashes, provider registration, subscription auth readiness, strict MCP/resource settings, and command/Git/worktree readiness. It marks missing subscription auth as `missing_auth`; it never swaps to environment API keys or another billing path.

- [ ] **Step 5: Replace defaults and operations**

Generate the spec's ready workflow and profiles on every `init`. `start` launches/reattaches the orchestrator Pi process directly; `recover` acquires the fenced lease and reconciles process records. Remove every Herdr CLI/socket/integration capability and status message.

- [ ] **Step 6: Verify packed clean-consumer behavior**

```ts
it("installs from the packed tarball without the source checkout", async () => {
  const consumer = await installPackedHarness();
  await consumer.run("harness", ["init"]);
  const plan = await consumer.runJson("harness", ["setup", "--dry-run"]);
  expect(plan.steps.some((step) => step.id === "pi-devin-acp")).toBe(true);
  expect(plan.steps.some((step) => /herdr/i.test(step.id))).toBe(false);
});
```

- [ ] **Step 7: Run CLI, loader, and packed-package tests; commit**

```bash
npx vitest run test/integration/init.test.ts test/integration/bootstrap.test.ts test/integration/doctor.test.ts test/integration/operations.test.ts test/integration/recover-cli.test.ts test/integration/pi-loader.test.ts test/unit/pi-commands.test.ts test/integration/packed-package.test.ts
npm run build
npm pack --dry-run --json
git add src/cli src/pi src/defaults bin package.json package-lock.json test/integration test/unit/pi-commands.test.ts test/support/package-consumer.ts
git commit -m "feat: ship Pi-native setup and workflow defaults"
```

---

### Task 8: Prove Fake, Crash, Isolation, and Real Subscription E2E

**Files:**
- Modify: `test/support/black-box-harness.ts`, `test/support/fault-injector.ts`, `test/e2e/fake-feature.test.ts`, `fake-controller.test.ts`, `durable-workflow.test.ts`, `production-pipeline.test.ts`, `crash-matrix.test.ts`, `race-matrix.test.ts`, `real-smoke.test.ts`, `vitest.config.ts`, `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`.
- Create: `test/e2e/managed-isolation.test.ts`, `test/e2e/pi-native-real.test.ts`.
- Modify docs: `README.md`, `SECURITY.md`, `docs/installation.md`, `docs/workflow-dsl.md`, `docs/recovery.md`, `docs/releasing.md`.
- Remove: Herdr compatibility scripts, tests, docs, and release workflow inputs.

**Interfaces:**
- Consumes: the complete Pi-native package and all prior phase gates.
- Produces: release verification scripts, clean fake E2E, crash/race matrix, managed isolation proof, opt-in real subscription E2E, updated docs, and final review evidence.

- [ ] **Step 1: Rewrite black-box fixtures around Pi processes and profiles**

The fake supervisor emits real-shaped Pi JSONL events and process records. Do not shortcut scheduler/result validation by injecting `DONE`. The black-box path must compile the DSL, seal a task graph, allocate worktrees, launch profile attempts, review, verify, integrate, project task state, and final-verify.

- [ ] **Step 2: Add the managed isolation E2E**

Create fixture-global Pi extension, Superpowers skill, Devin plugin, prompt template, and `AGENTS.md` markers containing unique forbidden strings. Run the release profiles and assert none of those markers appear in startup context, prompts, tool inventories, provider config, or transcripts unless explicitly declared.

- [ ] **Step 3: Complete the crash/race matrix**

Inject crashes before/after prepared record, spawn, process record fsync, first event, result write, terminal event, completion record, worktree release, integration CAS, task projection, push, and PR observation. Race process exit, timer, operator cancel/retry, and controller restart. Assert one effect observation, no duplicate launch, valid journal chain, and deterministic replay.

- [ ] **Step 4: Run the full non-subscription release gate**

```bash
npm run typecheck
npm run build
npx vitest run
npm pack --dry-run --json
! rg -i "herdr" src test scripts package.json .github --glob '!**/*.map'
```

Expected: all active tests pass, package inspection passes, and only explicitly retained historical design/plan files mention Herdr.

- [ ] **Step 5: Run real authenticated Codex-to-Devin-to-review E2E**

```bash
HARNESS_E2E_REAL=1 npm test -- test/e2e/pi-native-real.test.ts
```

The test installs the packed harness, creates a disposable repository, uses managed profile auth readiness, asks planner-codex/Spec Kit for specification and plan artifacts, runs one Devin implementation in an isolated worktree using Superpowers discipline, restarts the runtime and recovers the attempt from durable evidence, runs an independent Codex review, integrates the exact commit, and runs final verification. If a required subscription is unavailable, the release gate fails with an exact auth instruction; it is not recorded as a passing skip.

- [ ] **Step 6: Document installation, DSL, security, and recovery exactly**

Document Node upgrade, `harness init`, setup approval, one-time managed profile authentication, default and alternate workflows, profile fields/resource targets, state paths, crash semantics, manual recovery, security isolation, package versions, real E2E invocation, and the absence of remote/Herdr behavior.

- [ ] **Step 7: Commit release behavior**

```bash
git add -A .github package.json vitest.config.ts test README.md SECURITY.md docs src scripts
git commit -m "test: prove Pi-native orchestration end to end"
```

---

### Task 9: Final Audit, Independent Review, and Pull Request

**Files:**
- Modify only files required by verified review findings.
- Produce: final verification output, requirement audit, reviewed commit identity, pushed branch, and attached pull request.

**Interfaces:**
- Consumes: Tasks 0–8 and the complete spec.
- Produces: release evidence proving every success criterion and no unresolved review finding.

- [ ] **Step 1: Run the release gate from a clean worktree**

```bash
git status --short
npm run verify
HARNESS_E2E_REAL=1 npm test -- test/e2e/pi-native-real.test.ts
```

Expected: clean status before generated evidence, all verification passes, and the real E2E passes rather than skips.

- [ ] **Step 2: Audit every spec criterion against authoritative evidence**

Record a table mapping all ten success criteria and every release gate to a file, command output, test, artifact hash, or real run evidence. Missing or indirect evidence is a failure requiring implementation or stronger verification.

- [ ] **Step 3: Request an independent whole-branch review**

The reviewer reads the spec and plan, compares `main...HEAD`, checks durable-effect safety, profile isolation, provider/session semantics, Git correctness, install trust, package contents, and E2E evidence, then returns concrete findings bound to the exact HEAD commit.

- [ ] **Step 4: Fix each verified finding with TDD and rerun affected/full gates**

For every accepted finding, add or strengthen a failing test, implement the smallest complete correction, run the focused test, then rerun `npm run verify` and the real E2E when runtime behavior changed. Commit fixes with descriptive messages.

- [ ] **Step 5: Push the exact reviewed commit and create the final PR**

```bash
git push -u origin feat/pi-multi-agent-orchestrator
gh pr create --base main --head feat/pi-multi-agent-orchestrator \
  --title "feat: add Pi-native multi-agent orchestrator" \
  --body-file .harness-output/final-pr.md
```

Verify the remote branch equals local HEAD, attach the PR to the task, and only then mark the goal complete.

## Verification Commands

The migration replaces the old phase-3 Herdr gate with Pi-native gates:

```json
{
  "scripts": {
    "check:profiles": "vitest run test/unit/contracts test/unit/config test/unit/core/routing.test.ts test/unit/core/policy.test.ts",
    "check:managed": "vitest run test/unit/runtime/managed-paths.test.ts test/unit/runtime/managed-environment.test.ts test/integration/install test/integration/bootstrap.test.ts test/integration/doctor.test.ts",
    "check:pi-runtime": "vitest run test/unit/runtime test/contract test/integration/pi-process test/integration/pi-worker test/integration/production",
    "check:planning": "vitest run test/unit/pi-planning-port.test.ts test/integration/speckit test/integration/pi-residency.test.ts",
    "verify": "npm run typecheck && npm run build && vitest run && npm pack --dry-run --json",
    "e2e:real": "HARNESS_E2E_REAL=1 vitest run test/e2e/pi-native-real.test.ts"
  }
}
```

## Completion Rule

The migration is complete only after Task 9 proves every written success
criterion, `npm run verify`, real local-subscription E2E, managed isolation,
crash/recovery, independent review, package inspection, exact push, and final PR
creation. A green inherited unit suite, fake-only E2E, or successful provider
spike is not completion.
