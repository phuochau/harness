import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { EffectExecutor } from "../../src/actions/executor.js";
import { ActionRegistry } from "../../src/actions/registry.js";
import type {
  ActionContext,
  ActionDependencies,
  ActionHandler,
  EffectIntent,
  GitPort,
  ReconcileResult,
  RecoveryClass,
} from "../../src/actions/types.js";
import type { JsonValue } from "../../src/contracts/common.js";
import type { HarnessEvent } from "../../src/contracts/events.js";
import { validateHarnessEvent } from "../../src/contracts/events.js";
import {
  decisionBatchHash,
  reduceEvent,
} from "../../src/core/reducer.js";
import { initialRunState, type RunState } from "../../src/core/state.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import { sha256 } from "../../src/shared/sha256.js";
import { ZERO_HASH } from "../../src/state/hash-chain.js";
import { Journal, type EventInput } from "../../src/state/journal.js";
import { RunLease, type LeaseHandle } from "../../src/state/lease.js";
import { resolveRunPaths } from "../../src/state/paths.js";
import {
  writeSnapshot,
  type EventBoundary,
} from "../../src/state/snapshot.js";
import type { RunPaths } from "../../src/state/types.js";
import type { DeepPartial } from "./fixture.js";
import { deepMerge } from "./fixture.js";
import { fixtureState, type FixtureState } from "./factories.js";
import { completedResult } from "./factories.js";
import { FakeClock } from "./fake-clock.js";
import { FakeProcessRunner } from "./fake-process.js";
import { createTempRepo } from "./temp-repo.js";

export interface TempRepoWithWorktree {
  readonly repository: string;
  readonly worktree: string;
  readonly commonDir: string;
  cleanup(): Promise<void>;
}

export async function createTempRepoWithWorktree(): Promise<TempRepoWithWorktree> {
  const repo = await createTempRepo();
  const worktreeParent = await mkdtemp(join(tmpdir(), "pi-harness-linked-"));
  const worktree = join(worktreeParent, "worktree");
  const add = await repo.process.run(
    "git",
    ["worktree", "add", "-b", "fixture-linked", worktree],
    { cwd: repo.path, shell: false },
  );
  if (add.exitCode !== 0) {
    await rm(worktreeParent, { recursive: true, force: true });
    await rm(repo.path, { recursive: true, force: true });
    throw new Error(add.stderr);
  }
  const common = await repo.process.run(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: worktree, shell: false },
  );
  if (common.exitCode !== 0) throw new Error(common.stderr);
  const commonDir = common.stdout.trim();
  return {
    repository: repo.path,
    worktree,
    commonDir,
    cleanup: async () => {
      await repo.process.run("git", ["worktree", "remove", "--force", worktree], {
        cwd: repo.path,
        shell: false,
      });
      await rm(worktreeParent, { recursive: true, force: true });
      await rm(repo.path, { recursive: true, force: true });
    },
  };
}

const hashA = `sha256:${"a".repeat(64)}` as const;

function payloadFor(eventType: HarnessEvent["eventType"]): JsonValue {
  if (eventType === "effect.intent") {
    return {
      action: "worker.start",
      idempotencyKey: "launch:T001:1",
      recovery: "reconcilable",
      laneKey: "worker:T001",
      input: {},
    };
  }
  if (eventType === "run.created") return { workflowRevision: hashA };
  return {};
}

export function fixtureEventInput(
  overrides: DeepPartial<EventInput> = {},
): EventInput {
  const eventType = (overrides.eventType ?? "job.ready") as HarnessEvent["eventType"];
  const base: EventInput = {
    schemaVersion: 1,
    timestamp: "2026-09-20T00:00:00.000Z",
    runId: "F023",
    entityId: "job:implement:T001",
    idempotencyKey: "ready:T001",
    eventType,
    payload: payloadFor(eventType),
  };
  return deepMerge(base, overrides);
}

export interface JournalFixture {
  readonly paths: RunPaths;
  readonly journal: Journal;
  readonly lease: LeaseHandle;
  cleanup(): Promise<void>;
}

export async function journalFixture(): Promise<JournalFixture> {
  const repo = await createTempRepoWithWorktree();
  const paths = await resolveRunPaths(repo.worktree, "F023");
  const lease = await RunLease.acquire(paths, "controller-a");
  return {
    paths,
    journal: new Journal(paths),
    lease,
    cleanup: repo.cleanup,
  };
}

export interface PersistedRunOptions {
  readonly events?: number;
  readonly snapshotAt?: number;
  readonly tornTail?: boolean;
  readonly corruptSequence?: number;
}

export interface PersistedRunFixture extends JournalFixture {
  readonly state: FixtureState;
  readonly boundary: EventBoundary;
}

export async function persistedRunFixture(
  options: PersistedRunOptions = {},
): Promise<PersistedRunFixture> {
  const fixture = await journalFixture();
  const eventCount = options.events ?? 2;
  const events: HarnessEvent[] = [];
  for (let index = 0; index < eventCount; index += 1) {
    const result = await fixture.journal.append(
      fixtureEventInput({
        idempotencyKey: `event:${index + 1}`,
        entityId: `job:${index + 1}`,
      }),
      fixture.lease,
    );
    events.push(result.event);
  }
  const snapshotAt = Math.min(options.snapshotAt ?? 0, events.length);
  const boundary: EventBoundary =
    snapshotAt === 0
      ? {
          sequence: 0,
          eventHash: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
        }
      : {
          sequence: snapshotAt,
          eventHash: events[snapshotAt - 1]!.eventHash as `sha256:${string}`,
        };
  const state = fixtureState({
    sequence: boundary.sequence,
    eventHash: boundary.eventHash,
  });
  if (options.snapshotAt !== undefined) {
    await writeSnapshot(fixture.paths, state, boundary, fixture.lease);
  }
  if (options.corruptSequence !== undefined) {
    const lines = (await readFile(fixture.paths.events, "utf8"))
      .trimEnd()
      .split("\n");
    const target = options.corruptSequence - 1;
    const event = JSON.parse(lines[target]!) as Record<string, unknown>;
    event.sequence = 999;
    lines[target] = JSON.stringify(event);
    await writeFile(fixture.paths.events, `${lines.join("\n")}\n`, "utf8");
  }
  if (options.tornTail) {
    await appendFile(fixture.paths.events, '{"partial":', "utf8");
  }
  return { ...fixture, state, boundary };
}

export interface EventDraftOverrides {
  readonly sequence?: number;
  readonly timestamp?: string;
  readonly runId?: string;
  readonly entityId: string;
  readonly idempotencyKey: string;
  readonly eventType: HarnessEvent["eventType"];
  readonly payload: JsonValue;
}

export function nextHarnessEvent(
  state: Pick<RunState, "runId" | "lastSequence" | "lastEventHash">,
  draft: EventDraftOverrides,
): HarnessEvent {
  const unsigned = {
    schemaVersion: 1,
    sequence: draft.sequence ?? state.lastSequence + 1,
    timestamp: draft.timestamp ?? "2026-09-20T00:00:00.000Z",
    runId: draft.runId ?? state.runId,
    entityId: draft.entityId,
    idempotencyKey: draft.idempotencyKey,
    fencingToken: 1,
    prevHash: state.lastEventHash,
    eventType: draft.eventType,
    payload: draft.payload,
  };
  return validateHarnessEvent({
    ...unsigned,
    eventHash: sha256(canonicalJson(unsigned)),
  });
}

interface EventCursor {
  runId: string;
  lastSequence: number;
  lastEventHash: string;
}

function buildEvents(drafts: readonly EventDraftOverrides[]): HarnessEvent[] {
  const cursor: EventCursor = {
    runId: "F023",
    lastSequence: 0,
    lastEventHash: ZERO_HASH,
  };
  return drafts.map((draft) => {
    const event = nextHarnessEvent(cursor, draft);
    cursor.lastSequence = event.sequence;
    cursor.lastEventHash = event.eventHash;
    return event;
  });
}

const workflowRevision = `sha256:${"a".repeat(64)}` as const;

function runCreatedDraft(): EventDraftOverrides {
  return {
    eventType: "run.created",
    entityId: "run:F023",
    idempotencyKey: "run:create",
    payload: { workflowRevision },
  };
}

export function fixtureEventsThroughWorkerCompletion(): HarnessEvent[] {
  return buildEvents([
    runCreatedDraft(),
    {
      eventType: "job.ready",
      entityId: "implement:T001",
      idempotencyKey: "ready:T001",
      payload: {},
    },
    {
      eventType: "attempt.started",
      entityId: "implement:T001",
      idempotencyKey: "attempt:T001:1",
      payload: { attempt: 1, worker: "devin" },
    },
    {
      eventType: "worker.result_observed",
      entityId: "implement:T001",
      idempotencyKey: "result:T001:1",
      payload: completedResult() as JsonValue,
    },
  ]);
}

export function fixtureSuccessfulTaskEvents(): HarnessEvent[] {
  return buildEvents([
    runCreatedDraft(),
    {
      eventType: "job.ready",
      entityId: "implement:T001",
      idempotencyKey: "ready:T001",
      payload: {},
    },
    {
      eventType: "attempt.started",
      entityId: "implement:T001",
      idempotencyKey: "attempt:T001:1",
      payload: { attempt: 1, worker: "devin" },
    },
    {
      eventType: "worker.result_observed",
      entityId: "implement:T001",
      idempotencyKey: "result:T001:1",
      payload: completedResult() as JsonValue,
    },
    {
      eventType: "verification.passed",
      entityId: "implement:T001",
      idempotencyKey: "verify:T001",
      payload: { commit: "worker-head", evidence: ["tests"] },
    },
    {
      eventType: "integration.observed",
      entityId: "implement:T001",
      idempotencyKey: "integrate:T001",
      payload: {
        candidateCommit: "candidate",
        candidateRef: "refs/harness/candidate/T001",
        expectedRunHead: "run-head",
        patchId: "patch-id",
      },
    },
    {
      eventType: "task.finalized",
      entityId: "implement:T001",
      idempotencyKey: "finalize:T001",
      payload: {
        taskId: "T001",
        candidateCommit: "candidate",
        targetCommit: "target",
        tasksSemanticHash: workflowRevision,
      },
    },
    {
      eventType: "job.done",
      entityId: "implement:T001",
      idempotencyKey: "done:T001",
      payload: {},
    },
  ]);
}

function commandDecisionDrafts() {
  return {
    event: {
      eventType: "operator.intent",
      entityId: "run:F023",
      idempotencyKey: "operator:pause",
      payload: { operation: "pause", target: "run:F023", arguments: {} },
    },
    effect: {
      action: "worker.start",
      idempotencyKey: "effect:start:T001",
      recovery: "reconcilable",
      laneKey: "worker:T001",
      input: {},
    },
  } as const;
}

export function fixtureEventsThroughCommandDecision(
  options: { omitMember?: number } = {},
): HarnessEvent[] {
  const members = commandDecisionDrafts();
  const initial = buildEvents([runCreatedDraft()]);
  const cursor: EventCursor = {
    runId: "F023",
    lastSequence: initial[0]!.sequence,
    lastEventHash: initial[0]!.eventHash,
  };
  const command = {
    schemaVersion: 1 as const,
    source: "operator" as const,
    kind: "operator_intent" as const,
    idempotencyKey: "command:pause",
    payload: {},
  };
  const received = nextHarnessEvent(cursor, {
    eventType: "controller.command_received",
    entityId: "run:F023",
    idempotencyKey: command.idempotencyKey,
    payload: { command },
  });
  cursor.lastSequence = received.sequence;
  cursor.lastEventHash = received.eventHash;
  const unsignedBatch = {
    commandKey: command.idempotencyKey,
    acceptedSequence: received.sequence,
    acceptedAt: received.timestamp,
    stateRevision: received.sequence,
    events: [members.event],
    effects: [members.effect],
  };
  const decided = nextHarnessEvent(cursor, {
    eventType: "controller.command_decided",
    entityId: "run:F023",
    idempotencyKey: `decision:${command.idempotencyKey}`,
    payload: {
      ...unsignedBatch,
      decisionHash: decisionBatchHash(unsignedBatch),
    },
  });
  cursor.lastSequence = decided.sequence;
  cursor.lastEventHash = decided.eventHash;
  const memberDrafts: EventDraftOverrides[] = [
    members.event,
    {
      eventType: "effect.intent",
      entityId: "implement:T001",
      idempotencyKey: members.effect.idempotencyKey,
      payload: members.effect,
    },
  ];
  const keep = Math.max(0, memberDrafts.length - (options.omitMember ?? 0));
  const memberEvents = memberDrafts.slice(0, keep).map((draft) => {
    const event = nextHarnessEvent(cursor, draft);
    cursor.lastSequence = event.sequence;
    cursor.lastEventHash = event.eventHash;
    return event;
  });
  return [...initial, received, decided, ...memberEvents];
}

export function fixtureCommandProcessedEvent(state: RunState): HarnessEvent {
  return nextHarnessEvent(state, {
    eventType: "controller.command_processed",
    entityId: "run:F023",
    idempotencyKey: "processed:command:pause",
    payload: { source: "operator", commandKey: "command:pause" },
  });
}

export function fixtureEventsWithIntentObservationPauseRetryAndPlanning(): HarnessEvent[] {
  const base = fixtureEventsThroughCommandDecision();
  const state = replay(base);
  const drafts: EventDraftOverrides[] = [
    {
      eventType: "effect.observed",
      entityId: "implement:T001",
      idempotencyKey: "observed:effect:start:T001",
      payload: {
        action: "worker.start",
        intentKey: "effect:start:T001",
        output: { started: true },
      },
    },
    {
      eventType: "controller.command_processed",
      entityId: "run:F023",
      idempotencyKey: "processed:command:pause",
      payload: { source: "operator", commandKey: "command:pause" },
    },
    {
      eventType: "operator.intent",
      entityId: "run:F023",
      idempotencyKey: "operator:resume",
      payload: { operation: "resume", target: "run:F023", arguments: {} },
    },
    {
      eventType: "job.invalidated",
      entityId: "implement:T001",
      idempotencyKey: "retry:T001",
      payload: { supersededGeneration: 1, reason: "retry" },
    },
    {
      eventType: "planning.queued",
      entityId: "planning:specify",
      idempotencyKey: "planning:queued",
      payload: {
        stage: "specify",
        sessionFile: "session.jsonl",
        correlationId: "corr-1",
        requestEntryId: "entry-1",
        command: "/speckit.specify",
      },
    },
    {
      eventType: "planning.agent_settled",
      entityId: "planning:specify",
      idempotencyKey: "planning:settled",
      payload: { correlationId: "corr-1", finalTurnIndex: 2 },
    },
    {
      eventType: "planning.completed",
      entityId: "planning:specify",
      idempotencyKey: "planning:completed",
      payload: {
        stage: "specify",
        correlationId: "corr-1",
        hashes: { spec: workflowRevision },
      },
    },
  ];
  const cursor: EventCursor = {
    runId: state.runId,
    lastSequence: state.lastSequence,
    lastEventHash: state.lastEventHash,
  };
  const tail = drafts.map((draft) => {
    const event = nextHarnessEvent(cursor, draft);
    cursor.lastSequence = event.sequence;
    cursor.lastEventHash = event.eventHash;
    return event;
  });
  return [...base, ...tail];
}

export function replay(events: readonly HarnessEvent[]): RunState {
  let state = initialRunState("F023", workflowRevision);
  for (const event of events) state = reduceEvent(state, event);
  return state;
}

export const fixtureIntent = (
  overrides: Partial<EffectIntent<string, JsonValue>> = {},
): EffectIntent<string, JsonValue> => ({
  action: "worker.start",
  idempotencyKey: "effect:start:T001",
  recovery: "reconcilable",
  laneKey: "worker:T001",
  input: {},
  ...overrides,
});

function fakeGitPort(): GitPort {
  return {
    patchIdForRange: async () => "patch-id",
    findCommitByTrailer: async () => undefined,
    assertIntegrationMetadata: async () => undefined,
    assertWorktreeCommit: async () => undefined,
    commitTree: async () => "commit",
    updateRefCas: async () => undefined,
    revParse: async (ref) => ref,
    revParseOptional: async () => undefined,
    status: async () => [],
  };
}

export function actionContextDependencies(): ActionDependencies {
  return {
    process: new FakeProcessRunner(),
    git: fakeGitPort(),
    approvals: { get: async () => undefined },
    clock: new FakeClock(),
    signal: new AbortController().signal,
  };
}

export function actionContext(): ActionContext {
  return Object.freeze({ ...actionContextDependencies(), isRecovery: false });
}

export function recoveryContext(): ActionContext {
  return Object.freeze({ ...actionContextDependencies(), isRecovery: true });
}

export interface FakeHandlerOptions {
  readonly recovery?: (input: JsonValue) => RecoveryClass;
  readonly reconcile?: ReconcileResult<JsonValue>;
  readonly execute?: JsonValue;
}

export function fakeHandler(options: FakeHandlerOptions = {}) {
  const execute = vi.fn(async () => options.execute ?? { ok: true });
  const reconcile = vi.fn(
    async () => options.reconcile ?? ({ status: "not_found" } as const),
  );
  const handler: ActionHandler<"worker.start", JsonValue, JsonValue> = {
    kind: "worker.start",
    recovery: options.recovery ?? (() => "reconcilable"),
    execute,
    reconcile,
  };
  return Object.assign(handler, { execute, reconcile });
}

export function effectExecutor(
  handler: ReturnType<typeof fakeHandler>,
): EffectExecutor {
  const registry = new ActionRegistry();
  registry.register(handler);
  return new EffectExecutor(registry, actionContextDependencies());
}
