# Pi Orchestrator Phase 2: Durable State and Controller Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Read the parent plan and spec before each task.

**Goal:** Build the fenced event store, generic effect protocol, serialized controller queue, policy engine, and fake end-to-end scheduler.

**Architecture:** The journal is authoritative, snapshots are disposable materializations, and a lock-directory lease plus fencing rejects stale writers. All wakeups enter one FIFO command queue. The controller records effect intent before invoking an action handler and reconciles any intent without an observation before deciding whether execution is safe.

**Tech Stack:** Node filesystem APIs, `proper-lockfile`, TypeScript, Vitest, fast-check.

**Spec:** `docs/superpowers/specs/2026-09-20-pi-multi-agent-orchestrator-design.md`

## Task 7: Resolve Shared Run Paths and Acquire a Fenced Lease

**Files:**
- Create: `src/state/paths.ts`, `lease.ts`, `types.ts`
- Create: `test/support/state-fixtures.ts`
- Test: `test/unit/state/lease.test.ts`

**Interfaces:**
- Produces `resolveRunPaths(repo, runId)` and `RunLease.acquire(paths, ownerId): Promise<LeaseHandle>`.
- `LeaseHandle` exposes immutable `ownerId`, `fencingToken`, and `release()`.

- [ ] **Step 1: Write contention and stale-token tests**

```ts
it("places state under the Git common directory and increments fencing", async () => {
  const repo = await createTempRepoWithWorktree();
  const paths = await resolveRunPaths(repo.worktree, "F023");
  expect(paths.root).toBe(join(repo.commonDir, "harness/runs/F023"));
  const first = await RunLease.acquire(paths, "controller-a");
  await expect(RunLease.acquire(paths, "controller-b")).rejects.toThrow(/lease held/);
  await first.release();
  const second = await RunLease.acquire(paths, "controller-b");
  expect(second.fencingToken).toBe(first.fencingToken + 1);
});
```

- [ ] **Step 2: Run and observe missing lease implementation**

Run: `npm test -- test/unit/state/lease.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement canonical paths and lock-directory lease**

```ts
export class RunLease {
  static async acquire(paths: RunPaths, ownerId: string): Promise<LeaseHandle> {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    const releaseLock = await lockfile.lock(paths.root, { lockfilePath: paths.lockDir, stale: 30_000, retries: 0, realpath: false });
    try {
      const previous = await readLeaseRecord(paths.lease).catch(() => ({ fencingToken: 0 }));
      const record = { ownerId, fencingToken: previous.fencingToken + 1, acquiredAt: new Date().toISOString() };
      await atomicJson(paths.lease, record, 0o600);
      return new LeaseHandle(record, releaseLock);
    } catch (error) {
      await releaseLock();
      throw error;
    }
  }
}
```

The lock directory provides exclusion, not proof of ownership. Every later append rereads `lease.json` and compares the fencing token while the handle remains held.

- [ ] **Step 4: Run lease tests including two child processes**

Run: `npm test -- test/unit/state/lease.test.ts`

Expected: PASS; exactly one child acquires the lease.

- [ ] **Step 5: Commit**

```bash
git add src/state/paths.ts src/state/lease.ts src/state/types.ts test/unit/state/lease.test.ts
git commit -m "feat: acquire fenced run leases"
```

## Task 8: Append Hash-Chained Events with Duplicate-Key Protection

**Files:**
- Create: `src/state/journal.ts`, `src/state/hash-chain.ts`
- Modify: `test/support/state-fixtures.ts`
- Test: `test/unit/state/journal.test.ts`

**Interfaces:**
- Produces `Journal.append(input, lease): Promise<{ event: HarnessEvent; inserted: boolean }>`.
- Duplicate identity is `(runId, eventType, idempotencyKey)`; identical payload returns the existing event, conflicting payload throws.

- [ ] **Step 1: Write duplicate and fencing tests**

```ts
it("deduplicates identical appends and rejects key reuse", async () => {
  const { journal, lease } = await journalFixture();
  const input = fixtureEventInput({ eventType: "effect.intent", idempotencyKey: "launch:T001:1" });
  const first = await journal.append(input, lease);
  const second = await journal.append(input, lease);
  expect(first.inserted).toBe(true);
  expect(second).toEqual({ event: first.event, inserted: false });
  await expect(journal.append({ ...input, payload: { changed: true } }, lease)).rejects.toThrow(/idempotency collision/);
});

it("rejects a stale fencing token", async () => {
  const fixture = await journalFixture();
  const stale = fixture.lease;
  await stale.release();
  await RunLease.acquire(fixture.paths, "new-owner");
  await expect(fixture.journal.append(fixtureEventInput(), stale)).rejects.toThrow(/stale fencing token/);
});
```

- [ ] **Step 2: Run and observe missing journal**

Run: `npm test -- test/unit/state/journal.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement append under the held lease**

```ts
async append(input: EventInput, lease: LeaseHandle): Promise<AppendResult> {
  await lease.assertCurrent();
  const index = await this.readIdentityIndex();
  const identity = `${input.runId}\0${input.eventType}\0${input.idempotencyKey}`;
  const existing = index.get(identity);
  if (existing) {
    if (canonicalJson(existing.payload) !== canonicalJson(input.payload)) throw new IdempotencyCollision(identity);
    return { event: existing, inserted: false };
  }
  const previous = await this.lastEvent();
  const unsigned = { ...input, sequence: (previous?.sequence ?? 0) + 1, fencingToken: lease.fencingToken, prevHash: previous?.eventHash ?? ZERO_HASH };
  const event = { ...unsigned, eventHash: sha256(canonicalJson(unsigned)) };
  await appendAndFsync(this.paths.events, `${JSON.stringify(event)}\n`);
  return { event, inserted: true };
}
```

- [ ] **Step 4: Add property tests for sequence/hash stability**

```ts
fc.assert(fc.asyncProperty(fc.array(eventInputArbitrary(), { minLength: 1, maxLength: 100 }), async (inputs) => {
  const persisted = await appendInputs(inputs);
  expect(await reopenAndVerify(persisted.paths)).toEqual(persisted.events);
}));
await expect(verifyMutatedInteriorRecord()).rejects.toThrow(/hash chain/);
```

Run: `npm test -- test/unit/state/journal.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/journal.ts src/state/hash-chain.ts test/unit/state/journal.test.ts
git commit -m "feat: append fenced hash-chained events"
```

## Task 9: Write Snapshots and Recover from Torn Tails

**Files:**
- Create: `src/state/snapshot.ts`, `recovery.ts`
- Modify: `test/support/state-fixtures.ts`
- Test: `test/unit/state/recovery.test.ts`

**Interfaces:**
- Produces `writeSnapshot(paths, state, boundary, lease)` and `recoverJournal(paths, lease): RecoveryReport`.
- Only an incomplete final JSON line is repairable automatically.

- [ ] **Step 1: Write snapshot and corruption tests**

```ts
it("restores a snapshot boundary and truncates only an incomplete tail", async () => {
  const fixture = await persistedRunFixture({ events: 4, snapshotAt: 2, tornTail: true });
  const report = await recoverJournal(fixture.paths, fixture.lease);
  expect(report.repairedTail).toBe(true);
  expect(report.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
});

it("refuses interior corruption", async () => {
  const fixture = await persistedRunFixture({ events: 4, corruptSequence: 2 });
  await expect(recoverJournal(fixture.paths, fixture.lease)).rejects.toThrow(/interior corruption/);
});

it("rejects snapshot and repair writes after lease takeover", async () => {
  const fixture = await persistedRunFixture({ tornTail: true });
  const stale = fixture.lease;
  await stale.release();
  await RunLease.acquire(fixture.paths, "new-owner");
  await expect(writeSnapshot(fixture.paths, fixture.state, fixture.boundary, stale)).rejects.toThrow(/stale fencing token/);
  await expect(recoverJournal(fixture.paths, stale)).rejects.toThrow(/stale fencing token/);
});
```

- [ ] **Step 2: Run and observe missing recovery**

Run: `npm test -- test/unit/state/recovery.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement atomic snapshots and explicit tail repair**

```ts
export async function writeSnapshot(paths: RunPaths, state: RunState, boundary: EventBoundary, lease: LeaseHandle): Promise<void> {
  const temp = `${paths.snapshot}.${process.pid}.tmp`;
  await lease.assertCurrent();
  await writeFile(temp, JSON.stringify({ schemaVersion: 1, boundary, state }), { mode: 0o600 });
  await fsyncFile(temp);
  await lease.assertCurrent();
  await rename(temp, paths.snapshot);
  await fsyncDirectory(dirname(paths.snapshot));
}

export async function recoverJournal(paths: RunPaths, lease: LeaseHandle): Promise<RecoveryReport> {
  const bytes = await readFile(paths.events);
  const parsed = parseCompleteJsonLines(bytes);
  verifyHashChain(parsed.events);
  if (parsed.incompleteTail) {
    await lease.assertCurrent();
    await copyFile(paths.events, `${paths.events}.diagnostic-${Date.now()}`);
    await lease.assertCurrent();
    await truncate(paths.events, parsed.completeByteLength);
    await fsyncFile(paths.events);
  }
  return { events: parsed.events, repairedTail: Boolean(parsed.incompleteTail) };
}
```

- [ ] **Step 4: Prove replay from zero equals snapshot-plus-tail**

Run: `npm test -- test/unit/state/recovery.test.ts`

Expected: PASS for empty journal, valid snapshot, stale snapshot, torn tail, bad hash, sequence gap, and interior invalid JSON.

- [ ] **Step 5: Commit**

```bash
git add src/state/snapshot.ts src/state/recovery.ts test/unit/state/recovery.test.ts
git commit -m "feat: recover durable run state"
```

## Task 10: Reduce Events into Deterministic Run State

**Files:**
- Create: `src/core/state.ts`, `reducer.ts`, `lifecycle.ts`
- Modify: `test/support/state-fixtures.ts`
- Test: `test/unit/core/reducer.test.ts`

**Interfaces:**
- Produces `initialRunState(runId, revision)` and pure `reduceEvent(state, event): RunState`.

- [ ] **Step 1: Write lifecycle and replay tests**

```ts
it("cannot mark a job done without integrated verification evidence", () => {
  const state = replay(fixtureEventsThroughWorkerCompletion());
  expect(state.jobs["implement:T001"].state).toBe("VERIFYING");
  expect(() => reduceEvent(state, fixtureEvent({ eventType: "job.done" }))).toThrow(/integration evidence/);
});

it("replay is deterministic", () => {
  const events = fixtureSuccessfulTaskEvents();
  expect(replay(events)).toEqual(replay(structuredClone(events)));
});

it("replays controller, effect, operator, and planning events", () => {
  const state = replay(fixtureEventsWithIntentObservationPauseRetryAndPlanning());
  expect(state.outstandingEffects).toEqual({});
  expect(state.operator.paused).toBe(false);
  expect(state.planning.status).toBe("completed");
});
```

- [ ] **Step 2: Run and observe missing reducer**

Run: `npm test -- test/unit/core/reducer.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement an exhaustive event reducer**

```ts
export function reduceEvent(state: RunState, event: HarnessEvent): RunState {
  if (event.sequence !== state.lastSequence + 1) throw new ReducerError("sequence gap");
  const next = structuredClone(state);
  switch (event.eventType) {
    case "job.ready": transitionJob(next, event.entityId, "PENDING", "READY"); break;
    case "attempt.started": startAttempt(next, event); break;
    case "worker.routed": recordRouting(next, event); break;
    case "worker.result_observed": observeWorkerResult(next, event); break;
    case "review.approved": recordReview(next, event); break;
    case "review.changes_requested": requestRemediation(next, event); break;
    case "verification.passed": recordVerification(next, event); break;
    case "verification.failed": recordVerificationFailure(next, event); break;
    case "integration.observed": recordIntegration(next, event); break;
    case "integration.conflicted": recordIntegrationConflict(next, event); break;
    case "effect.intent": reserveEffect(next, event); break;
    case "effect.observed": observeEffect(next, event); break;
    case "effect.failed": failEffect(next, event); break;
    case "operator.intent": applyOperatorIntent(next, event); break;
    case "planning.queued": queuePlanning(next, event); break;
    case "planning.agent_settled": settlePlanningRun(next, event); break;
    case "planning.completed": completePlanning(next, event); break;
    case "planning.blocked": blockPlanning(next, event); break;
    case "run.created": initializeRun(next, event); break;
    case "job.done": assertDoneEvidence(next, event.entityId); transitionJob(next, event.entityId, "VERIFYING", "DONE"); break;
    case "job.invalidated": invalidateJobAndDependents(next, event); break;
    case "job.blocked": blockJob(next, event); break;
    case "job.failed": failJob(next, event); break;
    default: assertNever(event);
  }
  next.lastSequence = event.sequence;
  next.lastEventHash = event.eventHash;
  return deepFreeze(next);
}
```

- [ ] **Step 4: Add property tests for illegal transitions**

```ts
fc.assert(fc.property(illegalTransitionArbitrary(), ({ state, event }) => {
  expect(() => reduceEvent(state, event)).toThrow();
}));
```

Run: `npm test -- test/unit/core/reducer.test.ts`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.ts src/core/reducer.ts src/core/lifecycle.ts test/unit/core/reducer.test.ts
git commit -m "feat: reduce run events deterministically"
```

## Task 11: Define the Generic Effect Registry and Recovery Classes

**Files:**
- Create: `src/actions/types.ts`, `registry.ts`, `executor.ts`
- Modify: `test/support/state-fixtures.ts`
- Test: `test/unit/core/effects.test.ts`

**Interfaces:**
- Produces the parent plan's `ActionHandler`, `EffectIntent`, `ReconcileResult`, `ActionRegistry`, `EffectExecutor.runFresh(intent)`, and `EffectExecutor.recover(intent)`.

- [ ] **Step 1: Write recovery-class tests**

```ts
it("executes a fresh non-retryable intent without reconciling", async () => {
  const handler = fakeHandler({ recovery: () => "non_retryable", reconcile: { status: "indeterminate", evidence: ["not started"] } });
  await effectExecutor(handler).runFresh(fixtureIntent({ recovery: "non_retryable" }));
  expect(handler.reconcile).not.toHaveBeenCalled();
  expect(handler.execute).toHaveBeenCalledOnce();
});

it("reconciles during recovery before considering execution", async () => {
  const handler = fakeHandler({ recovery: () => "reconcilable", reconcile: { status: "observed", output: { agentId: "a1" } } });
  const result = await effectExecutor(handler).recover(fixtureIntent());
  expect(result).toEqual({ agentId: "a1" });
  expect(handler.execute).not.toHaveBeenCalled();
});

it("blocks an indeterminate non-retryable effect", async () => {
  const handler = fakeHandler({ recovery: () => "non_retryable", reconcile: { status: "indeterminate", evidence: ["exit status lost"] } });
  await expect(effectExecutor(handler).recover(fixtureIntent({ recovery: "non_retryable" }))).rejects.toMatchObject({ code: "INDETERMINATE_EFFECT" });
});
```

- [ ] **Step 2: Run and observe missing registry**

Run: `npm test -- test/unit/core/effects.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement registry and executor**

```ts
export class ActionRegistry {
  readonly #handlers = new Map<string, ActionHandler>();
  register(handler: ActionHandler): void {
    if (this.#handlers.has(handler.kind)) throw new Error(`duplicate action ${handler.kind}`);
    this.#handlers.set(handler.kind, handler);
  }
  get(kind: string): ActionHandler {
    const handler = this.#handlers.get(kind);
    if (!handler) throw new Error(`unknown action ${kind}`);
    return handler;
  }
}

export class EffectExecutor {
  async runFresh(intent: EffectIntent): Promise<unknown> {
    const handler = this.registry.get(intent.action);
    const recovery = handler.recovery(intent.input);
    if (recovery !== intent.recovery) throw new Error(`recovery mismatch for ${intent.action}`);
    return handler.execute(this.contextFor(false), intent);
  }

  async recover(intent: EffectIntent): Promise<unknown> {
    const handler = this.registry.get(intent.action);
    const recovery = handler.recovery(intent.input);
    if (recovery !== intent.recovery) throw new Error(`recovery mismatch for ${intent.action}`);
    const prior = await handler.reconcile(this.contextFor(true), intent);
    if (prior.status === "observed") return prior.output;
    if (prior.status === "indeterminate" || recovery === "non_retryable") {
      throw new IndeterminateEffect(intent, prior.status === "indeterminate" ? prior.evidence : []);
    }
    return handler.execute(this.contextFor(true), intent);
  }
}
```

`contextFor(false)` and `contextFor(true)` create immutable contexts whose
`isRecovery` flag matches the call path. Reject a mismatch between
`intent.recovery` and the registered handler. An idempotent handler may execute
after `not_found`; a reconcilable handler may execute only after a definitive
`not_found`.

- [ ] **Step 4: Run effect tests**

Run: `npm test -- test/unit/core/effects.test.ts`

Expected: PASS for all three recovery classes.

- [ ] **Step 5: Commit**

```bash
git add src/actions test/unit/core/effects.test.ts
git commit -m "feat: define recoverable effect protocol"
```

## Task 12: Serialize Every Controller Command Source

**Files:**
- Create: `src/controller/command-queue.ts`, `command-source.ts`, `effect-lanes.ts`
- Create: `test/support/controller-fixtures.ts`
- Test: `test/integration/controller-race.test.ts`

**Interfaces:**
- Produces `ControllerCommandQueue.enqueue(command): Promise<CommandResult>` and `reserveEffectLanes(state, candidates): readonly EffectIntent[]`.
- Queue processing is FIFO and at most one reducer/decision transaction runs at a time.

- [ ] **Step 1: Write the timer/Herdr/operator race test**

```ts
it("serializes concurrent wakeups into one logical launch", async () => {
  const fixture = await controllerQueueFixture();
  const results = await Promise.all([
    fixture.queue.enqueue(command("timer", "tick:1")),
    fixture.queue.enqueue(command("herdr", "agent-idle:a1")),
    fixture.queue.enqueue(command("operator", "retry:T001")),
  ]);
  expect(fixture.maxConcurrentTransactions).toBe(1);
  expect(fixture.events.filter((event) => event.eventType === "effect.intent" && event.entityId === "implement:T001")).toHaveLength(1);
  expect(results).toHaveLength(3);
});

it("reserves at most one run-mutating effect until its observation", async () => {
  const fixture = await controllerQueueFixture({ readyIntegrations: ["T001", "T002"] });
  await fixture.queue.enqueue(command("timer", "tick:integration"));
  expect(fixture.events.filter((event) => event.eventType === "effect.intent" && event.payload.laneKey === "run-mutation:F023")).toHaveLength(1);
});
```

- [ ] **Step 2: Run and observe missing queue**

Run: `npm test -- test/integration/controller-race.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement a non-reentrant FIFO promise queue**

```ts
export class ControllerCommandQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue(command: ControllerCommand): Promise<CommandResult> {
    const result = this.#tail.then(() => this.processor.process(command));
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }
}
```

`processor.process` reloads the latest state after acquiring the lease, deduplicates the command idempotency key, derives decisions once, appends events, then writes the snapshot. It never holds a transaction open while an external effect runs; effect completion re-enters the queue as a new command.

`reserveEffectLanes` is part of the pure decision transaction. Outstanding
`effect.intent` events occupy their durable `laneKey` until a matching
`effect.observed` or terminal `effect.failed` event is reduced. Git integration,
push, and PR creation use `run-mutation:<runId>`; planning uses
`planning:<runId>`; worker lanes remain per job so independent tasks can run in
parallel. Candidate selection is stable by materialized job order.

- [ ] **Step 4: Repeat the race 100 times**

```ts
for (let iteration = 0; iteration < 100; iteration += 1) {
  const result = await runConcurrentWakeupRace();
  expect(result.maxConcurrentTransactions).toBe(1);
  expect(result.launchIntentCount).toBe(1);
}
```

Run: `npm test -- test/integration/controller-race.test.ts`

Expected: PASS with max concurrency 1 and one launch intent per attempt.

- [ ] **Step 5: Commit**

```bash
git add src/controller/command-queue.ts src/controller/command-source.ts src/controller/effect-lanes.ts test/integration/controller-race.test.ts
git commit -m "feat: serialize controller wakeups"
```

## Task 13: Apply Routing, Retry, and Independent-Review Policy

**Files:**
- Create: `src/core/routing.ts`, `retry.ts`, `review-policy.ts`
- Modify: `test/support/controller-fixtures.ts`
- Test: `test/unit/core/policy.test.ts`

**Interfaces:**
- Produces `selectWorker`, `nextRetry`, and `selectReviewer` as pure functions.

- [ ] **Step 1: Write fallback/reviewer tests**

```ts
it("uses Codex after Devin fails and Claude for independent review", () => {
  const implementation = selectWorker(routeFixture({ unavailable: ["devin"] }));
  expect(implementation.kind).toBe("codex");
  expect(selectReviewer(reviewFixture({ implementationWorker: "codex" })).kind).toBe("claude");
});

it("blocks when no distinct reviewer is eligible", () => {
  expect(() => selectReviewer(reviewFixture({ implementationWorker: "codex", unavailable: ["claude", "devin"] }))).toThrow(/independent reviewer/);
});
```

- [ ] **Step 2: Run and observe missing policy functions**

Run: `npm test -- test/unit/core/policy.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement ordered eligibility and bounded retry**

```ts
export function selectReviewer(input: ReviewSelection): WorkerProfile {
  const eligible = input.preference
    .map((kind) => input.profiles[kind])
    .filter((profile): profile is WorkerProfile => Boolean(profile))
    .filter((profile) => profile.kind !== input.implementationWorker)
    .filter((profile) => satisfies(profile, input.requirements) && !input.unavailable.has(profile.kind));
  if (!eligible[0]) throw new PolicyBlocker("NO_INDEPENDENT_REVIEWER");
  return eligible[0];
}
```

Retry consumes both attempt and elapsed-time budgets, never expands permissions, and records the reason for rerouting. Authentication, missing capability, spec conflict, and indeterminate effects block immediately.

- [ ] **Step 4: Run policy tests**

Run: `npm test -- test/unit/core/policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/routing.ts src/core/retry.ts src/core/review-policy.ts test/unit/core/policy.test.ts
git commit -m "feat: enforce routing and review policy"
```

## Task 14: Build Immutable Assignments and Validate Evidence

**Files:**
- Create: `src/core/assignment.ts`, `evidence.ts`, `protected-paths.ts`
- Modify: `test/support/controller-fixtures.ts`
- Test: `test/unit/core/evidence.test.ts`

**Interfaces:**
- Produces `createAssignment(input): WorkerAssignment` and `validateEvidence(assignment, result, git): EvidenceDecision`.

- [ ] **Step 1: Write evidence gate tests**

```ts
it("rejects protected-file edits and stale review commits", async () => {
  const assignment = createAssignment(assignmentFixture({ commit: "abc123" }));
  await expect(validateEvidence(assignment, completedResult(), fakeGit({ changed: ["spec.md"] }))).rejects.toThrow(/protected path/);
  await expect(validateEvidence(reviewAssignment({ commit: "abc123" }), approvedReview({ commit: "def456" }), fakeGit())).rejects.toThrow(/reviewed commit/);
});
```

- [ ] **Step 2: Run and observe missing assignment/evidence modules**

Run: `npm test -- test/unit/core/evidence.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement content-addressed assignments**

```ts
export function createAssignment(input: AssignmentInput): WorkerAssignment {
  const body = {
    schemaVersion: 1 as const,
    ...input,
    protectedPaths: ["spec.md", "plan.md", "tasks.md", "task-graph.json", ".harness/**", ".pi/**"],
  };
  return deepFreeze({ ...body, assignmentHash: sha256(canonicalJson(body)) });
}
```

Evidence requires assignment hash, exact base/head commits, clean result schema, required Superpowers records, declared tests, no protected edits, and for review: distinct worker kind, detached binding, unchanged pinned commit, and clean review worktree.

- [ ] **Step 4: Run evidence tests**

Run: `npm test -- test/unit/core/evidence.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/assignment.ts src/core/evidence.ts src/core/protected-paths.ts test/unit/core/evidence.test.ts
git commit -m "feat: validate immutable worker evidence"
```

## Task 15: Run the Scheduler and Controller Against Fake Effects

**Files:**
- Create: `src/core/scheduler.ts`, `src/controller/controller.ts`, `decision.ts`
- Create: `test/support/fake-action-registry.ts`
- Modify: `test/support/controller-fixtures.ts`
- Test: `test/e2e/fake-controller.test.ts`

**Interfaces:**
- Produces `HarnessController.enqueue(command)` and `deriveDecisions(state, graph, policy)`.
- The fake registry implements every action used by the default workflow, not only worker launch.

- [ ] **Step 1: Write a full fake diamond run**

```ts
it("runs a diamond graph through review, verification, integration, and final verification", async () => {
  const system = await createControllerFixture({ graph: diamondTaskGraph(), actionResults: successfulFakeResults() });
  await system.runToQuiescence();
  expect(system.state.tasks).toMatchObject({ T001: { state: "DONE" }, T002: { state: "DONE" }, T003: { state: "DONE" } });
  expect(system.metrics.maxConcurrentImplementations).toBe(2);
  expect(system.actionKinds()).toEqual(expect.arrayContaining(["worker.execute", "worker.review", "command.run", "git.integrate", "github.pull-request"]));
});
```

- [ ] **Step 2: Run and observe missing controller wiring**

Run: `npm test -- test/e2e/fake-controller.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement pure decisions and effect dispatch**

```ts
export class HarnessController {
  enqueue(command: ControllerCommand): Promise<CommandResult> {
    return this.queue.enqueue(command);
  }

  async process(command: ControllerCommand): Promise<CommandResult> {
    const state = await this.repository.load();
    const decisions = deriveDecisions(applyCommand(state, command), this.graph, this.policy);
    for (const decision of decisions.events) await this.repository.append(decision, this.lease);
    const reserved = reserveEffectLanes(this.repository.state, decisions.effects);
    for (const intent of reserved) await this.repository.append(effectIntentEvent(intent), this.lease);
    await this.repository.snapshot(this.lease);
    for (const intent of reserved) void this.dispatchFresh(intent);
    return { accepted: true, stateRevision: this.repository.lastSequence };
  }

  private async dispatchFresh(intent: EffectIntent): Promise<void> {
    try {
      const output = await this.effects.runFresh(intent);
      await this.enqueue(effectObservedCommand(intent, output));
    } catch (error) {
      await this.enqueue(effectFailedCommand(intent, error));
    }
  }
}
```

`deriveDecisions` returns ordinary lifecycle events separately from effect
candidates; it does not emit `effect.intent` itself. `reserveEffectLanes`
selects candidates and the controller appends each corresponding intent exactly
once before dispatch. `deriveDecisions` marks jobs ready only after every
dependency is done, observes capacity, creates immutable attempts, chooses
workers/reviewers, and never marks `DONE` directly from a worker claim.

- [ ] **Step 4: Add crash-before/after-observation cases and run phase gate**

```ts
for (const boundary of ["after-intent", "after-effect"] as const) {
  const system = await createControllerFixture({ crashAt: boundary, actionResults: successfulFakeResults() });
  await system.crashAndRestart();
  expect(system.executeCount("worker.execute", "implement:T001:1")).toBe(1);
  expect(system.observationCount("worker.execute", "implement:T001:1")).toBe(1);
}
```

Run: `npm run check:phase2`

Expected: PASS, including the repeated race test and fake end-to-end run.

- [ ] **Step 5: Commit and stop for milestone review**

```bash
git add src/core src/controller test/support/fake-action-registry.ts test/support/controller-fixtures.ts test/e2e/fake-controller.test.ts package.json package-lock.json
git commit -m "feat: run durable serialized controller"
```
