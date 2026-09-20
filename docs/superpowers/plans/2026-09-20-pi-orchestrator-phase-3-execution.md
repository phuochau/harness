# Pi Orchestrator Phase 3: Git and Herdr Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Replace fake external effects with recoverable Git, command, Herdr, and worker implementations.

**Architecture:** Git identity and Herdr-native IDs are reconciliation keys. Writable implementation/remediation worktrees and detached read-only review/verification worktrees have explicit ownership transitions. The Herdr client is generated from the installed protocol schema and validated against a real local server before adapters build on it.

**Tech Stack:** Git CLI, GitHub CLI, Herdr CLI/socket API, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Task 16: Create Planning, Integration, and Task Branches

**Files:**
- Create: `src/git/process.ts`, `repository.ts`, `branches.ts`
- Create: `test/support/git-fixtures.ts`
- Test: `test/integration/git/branches.test.ts`

**Interfaces:**
- Produces `GitRepository.inspect()`, `ensureRunBranch(runId, base)`, and `ensureTaskBranch(runId, taskId, integrationBase, expectedHead?)`.
- Every method accepts argv arrays and never invokes a shell.

- [ ] **Step 1: Write branch creation/reconciliation tests**

```ts
it("reuses a branch only when it points at the expected base", async () => {
  const repo = await createTempRepo();
  const first = await repo.ensureTaskBranch("F023", "T001", repo.initialCommit);
  const second = await repo.ensureTaskBranch("F023", "T001", repo.initialCommit);
  expect(second).toEqual(first);
  const progressed = await repo.commitOnBranch(first.name, "worker progress");
  await expect(repo.ensureTaskBranch("F023", "T001", repo.initialCommit)).rejects.toThrow(/unexpected head/);
  await expect(repo.ensureTaskBranch("F023", "T001", repo.initialCommit, progressed))
    .resolves.toMatchObject({ commit: progressed });
});

it("bases a dependent task on the integration commit containing every completed dependency", async () => {
  const repo = await createTempRepoWithIntegratedDependencies(["T001", "T002"]);
  const branch = await repo.ensureTaskBranch("F023", "T003", repo.integrationHead);
  expect(await repo.mergeBase(branch.name, repo.integrationHead)).toBe(repo.integrationHead);
});
```

- [ ] **Step 2: Run and observe missing Git repository**

Run: `npm test -- test/integration/git/branches.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement shell-free Git calls and identity checks**

```ts
export class GitRepository {
  async ensureTaskBranch(runId: string, taskId: string, integrationBase: string, expectedHead = integrationBase): Promise<BranchRef> {
    const name = `harness/${runId}-${taskId}`;
    const existing = await this.revParseOptional(`refs/heads/${name}`);
    if (existing && existing !== expectedHead) throw new GitInvariantError(`${name} has unexpected head ${existing}`);
    if (!existing) await this.git(["branch", name, integrationBase]);
    if (existing && !(await this.isAncestor(integrationBase, existing))) throw new GitInvariantError(`${name} escaped its recorded base`);
    return { name, baseCommit: integrationBase, commit: existing ?? integrationBase };
  }
  private git(argv: string[]): Promise<ProcessResult> {
    return this.process.run("git", ["-C", this.root, ...argv], { shell: false });
  }
}
```

Canonicalize the repository root, reject dirty planning/integration worktrees
before mutation, and record base/head SHAs for every operation. The scheduler
computes `integrationBase` only after all dependency integration observations
are present; for a multi-parent dependency set it is the single current run
branch head containing every dependency, never an arbitrary dependency branch.
Fresh attempts omit `expectedHead`; recovery supplies the head recorded by the
attempt or reconciled structured worker result. An unrecorded progressed branch
is never silently adopted, while a recorded descendant is not mistaken for
corruption after restart.

- [ ] **Step 4: Run Git branch tests**

Run: `npm test -- test/integration/git/branches.test.ts`

Expected: PASS for spaces in paths, existing correct branch, mismatched branch, and dependency commit selection.

- [ ] **Step 5: Commit**

```bash
git add src/git test/integration/git/branches.test.ts
git commit -m "feat: manage harness branches"
```

## Task 17: Enforce Worktree Ownership Transitions

**Files:**
- Create: `src/git/worktrees.ts`, `workspace-lifecycle.ts`
- Modify: `test/support/git-fixtures.ts`
- Test: `test/integration/git/worktrees.test.ts`

**Interfaces:**
- Produces `openPlanning`, `sealPlanningArtifacts`, `openImplementation`, `sealImplementation`, `releaseImplementation`, `openReview`, `openVerification`, `validateReview`, and `openRemediation`.
- Review/verification bindings have `branch: null` and `writable: false`.

- [ ] **Step 1: Write ownership and mutation tests**

```ts
it("reviews in a separate detached worktree after implementer release", async () => {
  const manager = await worktreeFixture();
  const implementation = await manager.openImplementation(taskAttempt());
  const resultCommit = await manager.commitWorkerChange(implementation.path);
  const sealed = await manager.sealImplementation(implementation, resultCommit);
  await expect(manager.openReview(reviewAttempt({ commit: sealed.headCommit }))).rejects.toThrow(/implementation workspace active/);
  await manager.releaseImplementation(implementation);
  const review = await manager.openReview(reviewAttempt({ commit: sealed.headCommit }));
  expect(review).toMatchObject({ branch: null, writable: false, commit: sealed.headCommit });
  expect(review.path).not.toBe(implementation.path);
});

it("seals the complete change when a worker creates multiple commits", async () => {
  const manager = await worktreeFixture();
  const implementation = await manager.openImplementation(taskAttempt());
  const [first, head] = await manager.commitTwoWorkerChanges(implementation.path);
  const sealed = await manager.sealImplementation(implementation, head);
  expect(sealed).toMatchObject({ baseCommit: implementation.baseCommit, headCommit: head });
  expect(sealed.patchId).toBe(await manager.patchIdForRange(implementation.baseCommit, head));
  expect(first).not.toBe(head);
});

it("seals the complete planning artifact tree on the run branch", async () => {
  const manager = await worktreeFixture();
  const planning = await manager.openPlanning({ runId: "F023", runBranch: "harness/run-F023" });
  const sealed = await manager.sealPlanningArtifacts(planning, expectedArtifactHashes());
  expect(sealed.commit).toBe(await manager.revParse("harness/run-F023"));
  expect(sealed.hashes).toEqual(expectedArtifactHashes());
});

it("rejects a dirty review worktree", async () => {
  const review = await cleanReviewBinding();
  await writeFile(join(review.path, "changed.txt"), "mutation");
  await expect(validateReview(review)).rejects.toThrow(/review workspace mutated/);
});
```

- [ ] **Step 2: Run and observe missing lifecycle manager**

Run: `npm test -- test/integration/git/worktrees.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement explicit role transitions**

```ts
async openReview(input: ReviewWorkspaceInput): Promise<WorktreeBinding> {
  if (await this.registry.hasActive("implementation", input.taskId)) throw new WorkspaceInvariantError("implementation workspace active");
  const path = this.paths.review(input.runId, input.taskId, input.attempt);
  await this.git(["worktree", "add", "--detach", path, input.commit]);
  await chmodTreeReadOnly(path, [".harness-output"]);
  return this.registry.add({ role: "review", path, branch: null, commit: input.commit, writable: false });
}

async sealImplementation(binding: WorktreeBinding, reportedCommit: string): Promise<SealedImplementation> {
  const head = (await this.gitAt(binding.path, ["rev-parse", "HEAD"])).stdout.trim();
  const status = await this.gitAt(binding.path, ["status", "--porcelain"]);
  if (head !== reportedCommit || status.stdout !== "") throw new WorkspaceInvariantError("implementation result is not a clean reported commit");
  if (!(await this.isAncestor(binding.baseCommit, head))) throw new WorkspaceInvariantError("implementation head is not descended from its assigned base");
  const changedPaths = await this.changedPaths(binding.baseCommit, head);
  this.policy.assertOwnedPaths(changedPaths, binding.assignment.ownedPaths);
  return this.registry.seal(binding, {
    baseCommit: binding.baseCommit,
    headCommit: head,
    sourceTree: await this.revParse(`${head}^{tree}`),
    patchId: await this.patchIdForRange(binding.baseCommit, head),
    changedPaths,
  });
}

async validateReview(binding: WorktreeBinding): Promise<void> {
  const head = await this.gitAt(binding.path, ["rev-parse", "HEAD"]);
  const status = await this.gitAt(binding.path, ["status", "--porcelain"]);
  if (head.trim() !== binding.commit || status.stdout !== "") throw new WorkspaceInvariantError("review workspace mutated or moved");
}
```

Only `.harness-output/` may be writable for the reviewer and it must be
excluded from Git status. `sealPlanningArtifacts` permits only the declared
Spec Kit paths, verifies their hashes, commits them on the run branch, and
returns that exact commit. `SealedImplementation` identifies the complete
`baseCommit..headCommit` change, not merely the final commit, and is immutable
input to verification, review, and integration. Remediation always creates a
new writable path with a new attempt number; never reopen the reviewer path.
Cleanup resolves and verifies the registered path/worktree identity immediately
before removal. It never force-removes an unsealed or dirty implementation
worktree; that path is retained/quarantined with recovery evidence for explicit
operator action.

- [ ] **Step 4: Run worktree tests**

Run: `npm test -- test/integration/git/worktrees.test.ts`

Expected: PASS, including cleanup after crashed process and refusal to remove an unregistered worktree.

- [ ] **Step 5: Commit**

```bash
git add src/git/worktrees.ts src/git/workspace-lifecycle.ts test/integration/git/worktrees.test.ts
git commit -m "feat: isolate implementation and review worktrees"
```

## Task 18: Add Command and Human-Approval Actions

**Files:**
- Create: `src/actions/command.ts`, `approval.ts`
- Modify: `test/support/git-fixtures.ts`
- Test: `test/unit/core/command-action.test.ts`, `approval-action.test.ts`

**Interfaces:**
- Registers `command.run` as `non_retryable` unless a declared probe exists; registers `human.approval` as `reconcilable`.

- [ ] **Step 1: Write command crash-safety tests**

```ts
it("blocks recovery of an unobserved command without a probe", async () => {
  const handler = new CommandAction(fakeProcess(), fakeCommandLedger());
  const intent = commandIntent({ argv: ["npm", "test"], probe: undefined });
  await expect(handler.reconcile(recoveryContext(), intent)).resolves.toMatchObject({ status: "indeterminate" });
});

it("runs verification only in a worktree pinned to the intended commit", async () => {
  const fixture = await commandActionFixture();
  const intent = commandIntent({ argv: ["npm", "test"], cwd: fixture.detachedPath, expectedCommit: fixture.commit });
  await fixture.handler.execute(actionContext(), intent);
  expect(fixture.process.calls[0].options.cwd).toBe(fixture.detachedPath);
  await expect(fixture.handler.execute(actionContext(), { ...intent, input: { ...intent.input, expectedCommit: "moved" } }))
    .rejects.toThrow(/verification worktree commit mismatch/);
});

it("reconciles an approval by request id", async () => {
  const handler = new ApprovalAction(fakeApprovals({ "approve:F023": true }));
  await expect(handler.reconcile(actionContext(), approvalIntent("approve:F023"))).resolves.toEqual({ status: "observed", output: { approved: true } });
});
```

- [ ] **Step 2: Run and observe missing handlers**

Run: `npm test -- test/unit/core/command-action.test.ts test/unit/core/approval-action.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement handlers with declared recovery semantics**

```ts
export class CommandAction implements ActionHandler<"command.run", CommandInput, CommandOutput> {
  readonly kind = "command.run" as const;
  recovery(input: CommandInput): RecoveryClass { return input.probe ? "reconcilable" : "non_retryable"; }
  async execute(ctx: ActionContext, intent: EffectIntent<"command.run", CommandInput>): Promise<CommandOutput> {
    if (intent.input.expectedCommit && !intent.input.cwd) throw new CommandInvariantError("expectedCommit requires cwd");
    if (intent.input.expectedCommit) await ctx.git.assertWorktreeCommit(intent.input.cwd!, intent.input.expectedCommit);
    return ctx.process.run(intent.input.argv[0], intent.input.argv.slice(1), { cwd: intent.input.cwd, env: intent.input.env, shell: false });
  }
  async reconcile(ctx: ActionContext, intent: EffectIntent<"command.run", CommandInput>): Promise<ReconcileResult<CommandOutput>> {
    if (!intent.input.probe) return { status: "indeterminate", evidence: ["command has no reconciliation probe"] };
    return runDeclaredProbe(ctx, intent.input.probe);
  }
}
```

The controller injects a detached verification binding and `expectedCommit` for
task verification, post-integration verification, and final verification; the
user-authored argv remains frozen. Approval reconciliation reads durable
operator events. Detached mode never opens an implicit prompt; it stays pending
until an explicit operator command is recorded.

- [ ] **Step 4: Run action tests**

Run: `npm test -- test/unit/core/command-action.test.ts test/unit/core/approval-action.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/actions/command.ts src/actions/approval.ts test/unit/core/command-action.test.ts test/unit/core/approval-action.test.ts
git commit -m "feat: add command and approval actions"
```

## Task 19: Add Git Verification, Integration, Task Projection, Push, and PR Actions

**Files:**
- Create: `src/actions/git-verify.ts`, `git-integrate.ts`, `git-project-task-status.ts`, `git-push.ts`, `github-pr.ts`
- Modify: `test/support/git-fixtures.ts`
- Test: `test/integration/git/actions.test.ts`

**Interfaces:**
- Registers `git.verify`, `git.integrate`, `git.project-task-status`, `git.push`, and `github.pull-request` with native reconciliation identities.

```ts
export interface IntegrationIdentity {
  effectKey: string;
  expectedRunHead: string;
  change: SealedImplementation;
}
export type GitIntegrateIntent = EffectIntent<"git.integrate", {
  expectedRunHead: string;
  sealedChange: SealedImplementation;
}>;
export interface IntegrationOutput {
  candidateCommit: string;
  candidateRef: string;
  expectedRunHead: string;
  patchId: string;
}
export type ProjectTaskStatusIntent = EffectIntent<"git.project-task-status", {
  runRef: string;
  expectedRunHead: string;
  candidateCommit: string;
  integrationIdentity: IntegrationIdentity;
  verificationEventId: string;
  taskId: string;
  tasksPath: string;
  tasksSemanticHash: string;
}>;
export interface TaskFinalizationOutput {
  targetCommit: string;
  candidateCommit: string;
  taskId: string;
}
```

- [ ] **Step 1: Write replay-safe integration/PR tests**

```ts
it("observes an existing full-range integration and pull request", async () => {
  const fixture = await integratedGitFixture();
  const integration = await fixture.integrate.reconcile(actionContext(), gitIntegrateIntent(fixture.sealedChange));
  expect(integration).toMatchObject({ status: "observed" });
  const pr = await fixture.pr.reconcile(actionContext(), prIntent({ head: fixture.runBranch, base: "main" }));
  expect(pr).toMatchObject({ status: "observed", output: { number: 1 } });
});

it("integrates every commit in the sealed source range exactly once", async () => {
  const fixture = await multiCommitGitFixture();
  const intent = gitIntegrateIntent(fixture.sealedChange);
  const output = await fixture.effects.runFresh(intent);
  expect(await fixture.candidateTreeContains(output.candidateCommit, ["first.txt", "second.txt"])).toBe(true);
  expect(await fixture.runHead()).toBe(fixture.expectedRunHead);
  await expect(fixture.integrate.reconcile(actionContext(), intent))
    .resolves.toMatchObject({ status: "observed", output });
});

it("refuses a candidate whose parent is not the intended run head", async () => {
  const fixture = await multiCommitGitFixture();
  const intent = gitIntegrateIntent(fixture.sealedChange);
  await fixture.installCandidateWithMatchingSourceTrailers(intent, { parent: fixture.otherRunHead });
  await expect(fixture.integrate.reconcile(actionContext(), intent)).resolves.toMatchObject({
    status: "indeterminate",
    evidence: expect.arrayContaining([expect.stringMatching(/expected run head/)]),
  });
});

it("atomically promotes the verified candidate and one checkbox transition", async () => {
  const fixture = await taskProjectionFixture("T001", { candidateWith: ["first.txt", "second.txt"] });
  const output = await fixture.effects.runFresh(fixture.intent);
  expect(await fixture.runHead()).toBe(output.targetCommit);
  expect(await fixture.runTreeContains(["first.txt", "second.txt"])).toBe(true);
  expect(await fixture.checkbox("T001")).toBe("checked");
  expect(await fixture.semanticHash()).toBe(fixture.intent.input.tasksSemanticHash);
  await expect(fixture.projectStatus.reconcile(actionContext(), fixture.intent))
    .resolves.toMatchObject({ status: "observed", output });
});

it("leaves the run branch unchanged when candidate verification fails", async () => {
  const fixture = await multiCommitGitFixture({ verification: "failed" });
  const before = await fixture.runHead();
  const candidate = await fixture.effects.runFresh(gitIntegrateIntent(fixture.sealedChange));
  await fixture.observeVerificationFailure(candidate.candidateCommit);
  expect(await fixture.runHead()).toBe(before);
  expect(fixture.projectStatusIntents()).toHaveLength(0);
});
```

- [ ] **Step 2: Run and observe missing Git actions**

Run: `npm test -- test/integration/git/actions.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement native identity probes**

```ts
async reconcile(ctx: ActionContext, intent: GitIntegrateIntent): Promise<ReconcileResult<IntegrationOutput>> {
  const candidateRef = `refs/harness/candidates/${sha256(intent.idempotencyKey).slice(7)}`;
  const matching = await ctx.git.revParseOptional(candidateRef);
  if (!matching) return { status: "not_found" };
  try {
    await ctx.git.assertIntegrationMetadata(matching, {
      effectKey: intent.idempotencyKey,
      expectedRunHead: intent.input.expectedRunHead,
      change: intent.input.sealedChange,
    });
  } catch (error) {
    return { status: "indeterminate", evidence: integrationIdentityEvidence(error, matching, candidateRef) };
  }
  return { status: "observed", output: {
    candidateCommit: matching,
    candidateRef,
    expectedRunHead: intent.input.expectedRunHead,
    patchId: intent.input.sealedChange.patchId,
  } };
}
```

```ts
async execute(ctx: ActionContext, intent: ProjectTaskStatusIntent): Promise<TaskFinalizationOutput> {
  await ctx.git.assertIntegrationMetadata(intent.input.candidateCommit, intent.input.integrationIdentity);
  await assertPassedVerification(this.events, intent.input.verificationEventId, intent.input.candidateCommit);
  const projected = await buildProjectedTaskTree(ctx.git, {
    candidateCommit: intent.input.candidateCommit,
    taskId: intent.input.taskId,
    tasksPath: intent.input.tasksPath,
    tasksSemanticHash: intent.input.tasksSemanticHash,
  });
  const finalCommit = await ctx.git.commitTree(projected.tree, {
    parent: intent.input.expectedRunHead,
    trailers: finalizationTrailers(intent, projected),
  });
  await ctx.git.updateRefCas(intent.input.runRef, finalCommit, intent.input.expectedRunHead);
  return { targetCommit: finalCommit, candidateCommit: intent.input.candidateCommit, taskId: intent.input.taskId };
}

async reconcile(ctx: ActionContext, intent: ProjectTaskStatusIntent): Promise<ReconcileResult<TaskFinalizationOutput>> {
  const commit = await ctx.git.findCommitByTrailer(intent.input.runRef, "Harness-Effect-Key", intent.idempotencyKey);
  if (!commit) return { status: "not_found" };
  const check = await verifyFinalizationIdentity(ctx, commit, intent);
  if (!check.ok) return { status: "indeterminate", evidence: check.evidence };
  return await ctx.git.revParse(intent.input.runRef) === commit
    ? { status: "observed", output: check.output }
    : { status: "indeterminate", evidence: [`final commit ${commit} exists but run ref does not point to it`] };
}
```

`git.integrate.execute` applies the complete binary diff from
`sealedChange.baseCommit` to `sealedChange.headCommit` in a detached candidate
worktree pinned to `expectedRunHead`. It writes a harness-owned candidate commit
whose sole parent is that exact head under
`refs/harness/candidates/${sha256(effectKey).slice(7)}` with trailers for the
effect key, expected run head, source base/head/tree, and patch ID; it does not
move the run branch. `assertIntegrationMetadata` verifies the ref target, sole
parent, and every trailer before reconciliation may report `observed`; a moved
or mismatched ref is `indeterminate`, never reusable. Its process
port obtains `git diff --binary --full-index` through `runBytes()` and passes the
unchanged bytes to `git apply --index` through `stdin`, without invoking a shell. A conflict aborts the
candidate index and returns typed remediation evidence.

After `post_integrate_verify` proves that exact candidate commit,
`git.project-task-status` first repeats the full candidate identity check and
binds the exact `verification.passed` observation. It locates exactly one task ID
in the candidate tree, normalizes only its checkbox, proves the semantic hash is
unchanged, creates a final harness-owned commit whose parent is
`expectedRunHead`, and advances the run branch with argv
`["update-ref", runBranch, finalCommit, expectedRunHead]`.
Code plus
task projection therefore become visible in one compare-and-swap mutation. Its
trailers bind the candidate, verification observation, task ID, semantic hash,
and effect key. Reconciliation probes the final trailer and verifies the run ref;
a stale run head returns a typed retry decision before mutation. The effect
observation and projected `DONE` transition are appended in the same controller
transaction. A failed post-integration verification leaves the run branch
unchanged; its candidate ref is retained as diagnostic evidence and a new
attempt receives a new effect key. Its reconciliation finds the final commit by
effect-key trailer, verifies its sole parent, candidate tree transformation,
verification observation, task ID, and semantic hash, and reports `observed`
only when the run ref equals that exact commit. `git.verify` binds command output to commit
SHA. The final-review observation supplies the immutable `reviewedCommit` used
by `git.push`; push rejects a moved local head and reconciles only when the
remote ref equals that exact commit. `github.pull-request` uses
`gh pr list --head --base --json number,url,headRefOid` before creation. Task
candidate preparation occupies a controller-level
`integration-pipeline:<runId>` reservation until the matching task is finalized,
blocked, or invalidated, so a second candidate cannot be based on the same run
head. Atomic promotion/task projection, push, and PR effects share the durable
`run-mutation:<runId>` effect lane introduced in Task 12; the command queue
alone is not treated as effect serialization. Conflicts return typed
remediation evidence instead of partial success.

- [ ] **Step 4: Run Git action tests**

Run: `npm test -- test/integration/git/actions.test.ts`

Expected: PASS for a multi-commit source range, an unchanged run branch before candidate verification, wrong-parent candidate rejection, atomic candidate promotion, duplicate intent, checkbox replay, semantic-hash preservation, stale-head compare-and-swap, conflict cleanup, dirty worktree, mismatched remote, and existing PR.

- [ ] **Step 5: Commit**

```bash
git add src/actions/git-verify.ts src/actions/git-integrate.ts src/actions/git-project-task-status.ts src/actions/git-push.ts src/actions/github-pr.ts test/integration/git/actions.test.ts
git commit -m "feat: add recoverable Git and PR actions"
```

## Task 20: Generate and Validate the Herdr Protocol Client

**Files:**
- Create: `scripts/generate-herdr-protocol.mjs`
- Create: `src/runtime/herdr/protocol.generated.ts`, `transport.ts`, `client.ts`
- Create: `test/support/herdr-fixtures.ts`
- Test: `test/integration/herdr/protocol.test.ts`, `compat-smoke.test.ts`

**Interfaces:**
- Produces `HerdrClient.request(method, params)` and `subscribe(listener)`.
- Generated types are derived from `herdr api schema --json`; the checked-in schema hash is recorded.

- [ ] **Step 1: Write fake transport and schema-hash tests**

```ts
it("correlates responses and validates event payloads", async () => {
  const transport = new FakeHerdrTransport();
  const client = new HerdrClient(transport);
  const pending = client.request("workspace.list", {});
  transport.receive(workspaceListResponse("harness-1", []));
  await expect(pending).resolves.toEqual(expect.objectContaining({ workspaces: [] }));
  expect(HERDR_SCHEMA_SHA256).toMatch(/^sha256:[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run and observe missing client**

Run: `npm test -- test/integration/herdr/protocol.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement newline-framed socket transport and generation**

```ts
export class HerdrClient {
  #sequence = 0;
  request<M extends HerdrMethod>(method: M, params: HerdrParams<M>): Promise<HerdrResult<M>> {
    const id = `harness-${++this.#sequence}`;
    return this.transport.request(validateHerdrRequest({ id, method, params })).then(validateHerdrResponse(method));
  }
}
```

The generator executes `herdr api schema --json`, canonicalizes the schema, writes the hash and TypeScript validators, and fails if unsupported required methods disappear. Never hand-copy socket shapes.

- [ ] **Step 4: Add an immediate real compatibility smoke**

When `HARNESS_COMPAT_HERDR=1`, connect to a disposable local Herdr server, request its schema, list workspaces, create/open a disposable workspace, and remove it. This test does not start Codex, Devin, Claude, or spend subscriptions.

```ts
it.runIf(process.env.HARNESS_COMPAT_HERDR === "1")("matches the installed Herdr protocol", async () => {
  const client = await connectInstalledHerdr();
  expect(await client.schemaHash()).toBe(HERDR_SCHEMA_SHA256);
  const workspace = await client.createDisposableWorkspace();
  await expect(client.request("workspace.list", {})).resolves.toEqual(expect.objectContaining({ workspaces: expect.any(Array) }));
  await client.removeWorkspace(workspace.id);
});
```

Run: `HARNESS_COMPAT_HERDR=1 npm test -- test/integration/herdr/compat-smoke.test.ts`

Expected: PASS on a developer/compatibility runner with Herdr installed; normal CI skips with an explicit reason.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-herdr-protocol.mjs src/runtime/herdr test/integration/herdr/protocol.test.ts test/integration/herdr/compat-smoke.test.ts
git commit -m "feat: add schema-validated Herdr client"
```

## Task 21: Reconcile Herdr Workspaces, Panes, and Agents

**Files:**
- Create: `src/runtime/herdr/runtime.ts`, `identity.ts`, `events.ts`
- Modify: `test/support/herdr-fixtures.ts`
- Test: `test/integration/herdr/runtime.test.ts`

**Interfaces:**
- Produces `HerdrRuntime.ensureWorkspace`, `startAgent`, `submitAssignment`, `observeAgent`, `stopAgent`, and event subscription.
- Stable identity is a deterministic Herdr-safe agent name plus the persisted workspace ID, pane ID, worktree provenance, assignment hash, and attempt generation. Display metadata is never used as the sole identity.
- Agent start is reconcilable by native identity. Prompt submission is a separate non-retryable effect when its delivery result is unknown.

- [ ] **Step 1: Write start/reconcile tests**

```ts
it("reattaches by stable native identity instead of launching twice", async () => {
  const runtime = herdrRuntimeFixture({ existingAgent: agentSnapshot({ identity: attemptIdentity() }) });
  const intent = workerStartIntent();
  await expect(runtime.reconcile(actionContext(), intent)).resolves.toMatchObject({ status: "observed" });
  expect(runtime.transport.calls("agent.start")).toHaveLength(0);
});

it("does not resend an assignment after an ambiguous prompt delivery", async () => {
  const runtime = herdrRuntimeFixture({ promptSentThenConnectionLost: true, result: undefined });
  await expect(runtime.recoverSubmit(actionContext(), submitAssignmentIntent()))
    .resolves.toMatchObject({ status: "indeterminate" });
  expect(runtime.transport.calls("agent.prompt")).toHaveLength(0);
});

it("reconciles ambiguous prompt delivery only from a matching structured result", async () => {
  const runtime = herdrRuntimeFixture({ promptSentThenConnectionLost: true, result: completedResult() });
  await expect(runtime.recoverSubmit(actionContext(), submitAssignmentIntent()))
    .resolves.toMatchObject({ status: "observed" });
});
```

- [ ] **Step 2: Run and observe missing runtime**

Run: `npm test -- test/integration/herdr/runtime.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement exact native-identity reconciliation**

```ts
async reconcile(_ctx: ActionContext, intent: WorkerStartIntent): Promise<ReconcileResult<WorkerHandle>> {
  const agent = await this.client.findAgentByName(intent.input.agentName);
  if (!agent) return { status: "not_found" };
  const binding = await this.client.inspectBinding(agent);
  return bindingMatches(binding, intent.input)
    ? { status: "observed", output: toHandle(agent, binding) }
    : { status: "indeterminate", evidence: bindingMismatchEvidence(binding, intent.input) };
}
```

Herdr `agent start` requires an existing available shell pane. Worktree/workspace
creation therefore returns and persists its root pane ID; reuse verifies that
the pane is still in the same workspace/worktree and back at its interactive
shell before launch. Start uses the deterministic name, worker `kind`, and exact
pane ID. The name satisfies Herdr's length/character contract and includes a
truncated hash of run/job/attempt/assignment identity. A same-name agent in a
different pane, changed worktree provenance, or changed assigned commit is
`indeterminate`, never reusable. Harness-owned pane/workspace metadata may show
the task and assignment to humans, but reconciliation trusts the durable intent
plus native name/pane/workspace/worktree facts.

Map Herdr states only to observations. `blocked`, `idle`, or `done` does not itself decide harness completion; the controller validates the result/evidence separately.

Submit an assignment only to the expected idle agent/pane and record it as its
own effect intent before calling `agent.prompt` without a combined lifecycle
wait. A successful API acknowledgement records the observation, then lifecycle
events drive collection. Herdr does not identify individual prompt turns, and a
timeout or broken connection does not prove that input was not sent. Recovery
therefore never resubmits that effect: a valid `.harness-output/result.json`
with the exact assignment hash may reconcile it as observed; working/idle/done
state, terminal prose, or absence of a result remains indeterminate and blocks
for operator inspection. A retry first stops the old agent, proves it no longer
owns the pane/worktree, and creates a new immutable attempt and prompt key.

- [ ] **Step 4: Run runtime tests**

Run: `npm test -- test/integration/herdr/runtime.test.ts`

Expected: PASS for reconnect, same-name identity collision, wrong-pane binding, missing pane, stopped agent, acknowledged prompt, ambiguous prompt without resend, matching-result reconciliation, and out-of-order events.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/herdr/runtime.ts src/runtime/herdr/identity.ts src/runtime/herdr/events.ts test/integration/herdr/runtime.test.ts
git commit -m "feat: reconcile Herdr agent lifecycle"
```

## Task 22: Define the Shared Worker Adapter Contract

**Files:**
- Create: `src/runtime/workers/types.ts`, `prompt.ts`, `result.ts`, `superpowers-profile.ts`
- Create: `test/contract/worker-contract.ts`
- Modify: `test/support/herdr-fixtures.ts`
- Test: `test/contract/workers.test.ts`

**Interfaces:**
- Produces `WorkerAdapter.probe`, `prepare`, `launchSpec`, `resumeSpec`, `cancelSpec`, `collect`, `parseResult`, and reusable `workerContract(name, factory)`. Lifecycle observation remains the shared Herdr runtime's responsibility.

- [ ] **Step 1: Write the shared contract**

```ts
export function workerContract(name: string, factory: WorkerAdapterFactory): void {
  describe(name, () => {
    it("pins assignment and protected paths in the prompt", async () => {
      const adapter = factory();
      const prepared = await adapter.prepare(contractAssignment());
      expect(prepared.prompt).toContain(contractAssignment().assignmentHash);
      expect(prepared.prompt).toContain("Do not modify spec.md");
    });
    it("returns a typed blocker and never treats prose as completion", async () => {
      const adapter = factory();
      expect(adapter.parseResult("looks done")).toEqual({ status: "invalid", reason: expect.any(String) });
    });
    it("binds resume to the exact native session reference", async () => {
      const adapter = factory();
      const prepared = await adapter.prepare(contractAssignment());
      const session = nativeSessionRef(name, "session-1");
      const capabilities = await adapter.probe(workerProbeContext());
      const spec = adapter.resumeSpec(prepared, session);
      expect(spec).toMatchObject(capabilities.nativeResume
        ? { status: "supported", session, assignmentHash: prepared.assignment.assignmentHash }
        : { status: "unsupported" });
      expect(() => adapter.resumeSpec(prepared, nativeSessionRef("other", "session-1"))).toThrow(/session source/);
    });
  });
}
```

- [ ] **Step 2: Run and observe missing adapter types**

Run: `npm test -- test/contract/workers.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement exact assignment/result protocol**

```ts
export interface WorkerAdapter {
  readonly kind: "codex" | "devin" | "claude";
  probe(context: WorkerProbeContext): Promise<WorkerCapabilities>;
  prepare(assignment: WorkerAssignment): Promise<PreparedWorker>;
  launchSpec(prepared: PreparedWorker): HerdrAgentSpec;
  resumeSpec(prepared: PreparedWorker, session: NativeAgentSession): SupportedResumeSpec | { status: "unsupported" };
  cancelSpec(handle: WorkerHandle): HerdrCancellationSpec;
  collect(prepared: PreparedWorker): Promise<ParsedWorkerResult>;
  parseResult(raw: string): ParsedWorkerResult;
}
```

`WorkerAssignment` is a discriminated union of implementation, task-review,
and final-diff-review assignments. Final-diff review binds the frozen base SHA,
run-branch head SHA, and detached read-only review worktree; it has no task ID
or writable remediation path. The prompt names readable planning files,
writable paths, required tests, exact result path, assignment hash, and allowed
Superpowers skills. Result acceptance reads only
`.harness-output/result.json`, validates the schema, and verifies the assignment
hash.

`probe` reports launch, native resume, cancellation, sandbox, and Superpowers
support independently. `resumeSpec` accepts only a persisted official session
reference whose source/worker kind and assignment attempt match; it never mines
a session ID from terminal text. When native resume is unsupported or the
reference cannot be verified, recovery stops any surviving old process and
creates a new attempt under retry policy instead of relaunching the old attempt.
`collect` reads only the assignment's expected result path and delegates to the
same schema validator. `cancelSpec` is explicit about graceful input versus
forced pane/process termination and its observation is reconciled before the
worktree can be reused or removed.

- [ ] **Step 4: Run the contract with a minimal fake adapter**

Run: `npm test -- test/contract/workers.test.ts`

Expected: PASS for fake adapter; real adapters are registered next.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/workers test/contract
git commit -m "feat: define worker adapter contract"
```

## Task 23: Implement Codex, Devin, and Claude Adapters

**Files:**
- Create: `src/runtime/workers/codex.ts`, `devin.ts`, `claude.ts`, `index.ts`
- Modify: `test/support/herdr-fixtures.ts`
- Test: `test/contract/workers.test.ts`, `test/integration/herdr/worker-adapters.test.ts`

**Interfaces:**
- Produces registered worker kinds `codex`, `devin`, and `claude` with Herdr integration names and capability probes.

- [ ] **Step 1: Register all adapters in the shared contract**

```ts
workerContract("codex", () => new CodexAdapter());
workerContract("devin", () => new DevinAdapter());
workerContract("claude", () => new ClaudeAdapter());

it.each(["codex", "devin", "claude"] as const)("uses the %s Herdr integration", (kind) => {
  expect(workerAdapters().get(kind).launchSpec(preparedWorker()).kind).toBe(kind);
});
```

- [ ] **Step 2: Run and observe missing real adapters**

Run: `npm test -- test/contract/workers.test.ts test/integration/herdr/worker-adapters.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement declarative adapter descriptors**

```ts
export class CodexAdapter extends JsonResultWorkerAdapter {
  readonly kind = "codex" as const;
  launchSpec(prepared: PreparedWorker): HerdrAgentSpec {
    return { kind: "codex", cwd: prepared.assignment.worktree.path, prompt: prepared.prompt, metadata: prepared.metadata };
  }
}
```

Implement Devin and Claude identically except for `kind`, capability probe, and
pinned native resume/cancellation descriptors. Derive those descriptors from
the tested worker/Herdr integration contract; never guess a resume flag at
runtime. The runtime maps `kind` to Herdr's canonical agent kind and supplies
the already-created pane plus deterministic agent name; adapter metadata is
display-only. Keep routing order in workflow data, not adapter code. Task-review
prompts require review mode and reject the same worker kind as the
implementation evidence. Final-diff prompts compare the frozen run head to the
frozen base, run no mutation tools, and return the same typed
approved/changes-requested result without inventing remediation work.

- [ ] **Step 4: Run phase gate and optional real no-op worker smoke**

Run: `npm run check:phase3`

Optional, subscription-consuming: `HARNESS_E2E_REAL=1 npm test -- test/integration/herdr/worker-adapters.test.ts`

Expected: phase gate PASS with fakes; real smoke completes one disposable no-op assignment per authenticated worker and, where the probe reports native resume, detaches and resumes that exact session once.

- [ ] **Step 5: Commit and stop for milestone review**

```bash
git add src/runtime/workers test/contract/workers.test.ts test/integration/herdr/worker-adapters.test.ts package.json package-lock.json
git commit -m "feat: support Codex Devin and Claude workers"
```
