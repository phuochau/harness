import type { JsonValue } from "../../src/contracts/common.js";
import type { ControllerCommand } from "../../src/contracts/controller-command.js";
import type { TaskGraphDocument } from "../../src/contracts/task-graph.js";
import { compileWorkflow } from "../../src/config/compile.js";
import type {
  CommandDecisionBatch,
  DecisionEventDraft,
  HarnessEvent,
} from "../../src/contracts/events.js";
import {
  ControllerCommandQueue,
  type CommandQueueProcessor,
  type CommandResult,
} from "../../src/controller/command-queue.js";
import {
  DurableCommandProcessor,
  type AcceptedCommandRecord,
  type CommandDecision,
} from "../../src/controller/command-source.js";
import { reduceEvent } from "../../src/core/reducer.js";
import {
  createAssignment,
  type AssignmentInput,
  type WorkerAssignment,
} from "../../src/core/assignment.js";
import type { EvidenceGit } from "../../src/core/evidence.js";
import { initialRunState, type RunState } from "../../src/core/state.js";
import {
  WorkflowScheduler,
  type SchedulerAction,
} from "../../src/core/scheduler.js";
import { validateGraph } from "../../src/core/task-graph.js";
import type {
  ReviewSelection,
} from "../../src/core/review-policy.js";
import type {
  WorkerKind,
  WorkerProfile,
  WorkerSelection,
} from "../../src/core/routing.js";
import { Journal, type EventInput } from "../../src/state/journal.js";
import { RunLease, type LeaseHandle } from "../../src/state/lease.js";
import { resolveRunPaths } from "../../src/state/paths.js";
import type { RunPaths } from "../../src/state/types.js";
import { FakeClock } from "./fake-clock.js";
import type { DeepPartial } from "./fixture.js";
import { deepMerge, fixture } from "./fixture.js";
import { createTempRepoWithWorktree } from "./state-fixtures.js";
import {
  FakeActionRegistry,
  type CrashBoundary,
} from "./fake-action-registry.js";
import {
  diamondTaskGraph,
  fixtureCompileInput,
  fixtureGraphContextFor,
} from "./factories.js";

const revision = `sha256:${"a".repeat(64)}`;

export function command(
  source: ControllerCommand["source"],
  idempotencyKey: string,
  payload: JsonValue = {},
): ControllerCommand {
  const kindBySource = {
    controller: "effect_result",
    timer: "tick",
    herdr: "runtime_event",
    pi: "planning_turn",
    operator: "operator_intent",
    recovery: "recover",
  } as const;
  return {
    schemaVersion: 1,
    source,
    kind: kindBySource[source],
    idempotencyKey,
    payload,
  };
}

export interface ControllerQueueFixtureOptions {
  readonly readyIntegrations?: readonly string[];
  readonly crashAfterEvent?: HarnessEvent["eventType"];
  readonly crashAfterBatchMember?: number;
}

class InstrumentedProcessor
  implements CommandQueueProcessor<ControllerCommand>
{
  public constructor(
    private readonly inner: DurableCommandProcessor,
    private readonly onActive: (delta: number) => void,
  ) {}

  public accept(input: ControllerCommand) {
    return this.inner.accept(input);
  }

  public async processReceived(commandKey: string): Promise<CommandResult> {
    this.onActive(1);
    try {
      return await this.inner.processReceived(commandKey);
    } finally {
      this.onActive(-1);
    }
  }

  public pendingCommandKeysInSequenceOrder() {
    return this.inner.pendingCommandKeysInSequenceOrder();
  }
}

export class ControllerQueueFixture {
  public queue!: ControllerCommandQueue<ControllerCommand>;
  public readonly events: HarnessEvent[] = [];
  public readonly clock = new FakeClock();
  public maxConcurrentTransactions = 0;
  public state: RunState = initialRunState("F023", revision);
  private activeTransactions = 0;
  private crashEnabled = true;
  private readonly derivations = new Map<string, number>();

  public constructor(
    private readonly options: ControllerQueueFixtureOptions,
    private readonly paths: RunPaths,
    private readonly journal: Journal,
    private readonly lease: LeaseHandle,
    private readonly cleanupRepo: () => Promise<void>,
  ) {
    this.installQueue();
  }

  private derive = (
    state: RunState,
    accepted: AcceptedCommandRecord,
  ): CommandDecision => {
    const key = accepted.command.idempotencyKey;
    this.derivations.set(key, (this.derivations.get(key) ?? 0) + 1);
    const target = key.match(/T[0-9]{3,}/)?.[0] ?? "T001";
    const events: DecisionEventDraft[] = [];
    if (accepted.command.source === "operator") {
      events.push({
        eventType: "operator.intent",
        entityId: "run:F023",
        idempotencyKey: `operator:retry:${target}`,
        payload: { operation: "retry", target, arguments: {} },
      });
      if (
        accepted.command.payload &&
        typeof accepted.command.payload === "object" &&
        !Array.isArray(accepted.command.payload) &&
        accepted.command.payload.multi === true
      ) {
        events.push({
          eventType: "operator.intent",
          entityId: "run:F023",
          idempotencyKey: `operator:reroute:${target}`,
          payload: { operation: "reroute", target, arguments: {} },
        });
      }
    }
    const integrationTasks = this.options.readyIntegrations ?? [];
    const effects =
      integrationTasks.length > 0
        ? integrationTasks.map((taskId) => ({
            action: "git.integrate",
            idempotencyKey: `integrate:${taskId}`,
            recovery: "reconcilable" as const,
            laneKey: `integration-pipeline:${state.runId}`,
            input: {
              entityId: `integrate:${taskId}`,
              taskId,
              acceptedAt: accepted.acceptedAt,
            },
          }))
        : [
            {
              action: "worker.start",
              idempotencyKey: "launch:implement:T001:1",
              recovery: "reconcilable" as const,
              laneKey: "worker:implement:T001",
              input: {
                entityId: "implement:T001",
                acceptedAt: accepted.acceptedAt,
              },
            },
          ];
    return { events, effects };
  };

  private installQueue(): void {
    const processor = new DurableCommandProcessor({
      runId: "F023",
      workflowRevision: revision,
      journal: this.journal,
      lease: this.lease,
      clock: this.clock,
      derive: this.derive,
      hooks: {
        afterAppend: async (event) => {
          this.events.push(event);
          this.state = reduceEvent(this.state, event);
          if (
            this.crashEnabled &&
            this.options.crashAfterEvent === event.eventType
          ) {
            throw new Error(`injected crash after ${event.eventType}`);
          }
        },
        afterBatchMember: async (count) => {
          if (
            this.crashEnabled &&
            this.options.crashAfterBatchMember === count
          ) {
            throw new Error(`injected crash after batch member ${count}`);
          }
        },
      },
    });
    const instrumented = new InstrumentedProcessor(processor, (delta) => {
      this.activeTransactions += delta;
      this.maxConcurrentTransactions = Math.max(
        this.maxConcurrentTransactions,
        this.activeTransactions,
      );
    });
    this.queue = new ControllerCommandQueue(instrumented);
  }

  public async restart(): Promise<void> {
    this.crashEnabled = false;
    this.installQueue();
  }

  public async restartAndRecoverPending(): Promise<void> {
    await this.restart();
    await this.queue.recoverPending();
  }

  public integrationIntents(): HarnessEvent[] {
    return this.events.filter(
      (event) =>
        event.eventType === "effect.intent" &&
        event.payload.action === "git.integrate",
    );
  }

  private async append(input: EventInput): Promise<void> {
    const result = await this.journal.append(input, this.lease);
    if (result.inserted) {
      this.events.push(result.event);
      this.state = reduceEvent(this.state, result.event);
    }
  }

  public async observeCandidateWithoutFinalizing(): Promise<void> {
    const intent = this.integrationIntents()[0];
    if (!intent || intent.eventType !== "effect.intent") {
      throw new Error("no integration intent to observe");
    }
    const taskId = (intent.payload.input as { taskId: string }).taskId;
    const timestamp = this.clock.now().toISOString();
    await this.append({
      schemaVersion: 1,
      timestamp,
      runId: "F023",
      entityId: `integrate:${taskId}`,
      idempotencyKey: `observed:${intent.payload.idempotencyKey}`,
      eventType: "effect.observed",
      payload: {
        action: "git.integrate",
        intentKey: intent.payload.idempotencyKey,
        output: { candidateCommit: "candidate" },
      },
    });
    await this.append({
      schemaVersion: 1,
      timestamp,
      runId: "F023",
      entityId: `integrate:${taskId}`,
      idempotencyKey: `candidate:${taskId}`,
      eventType: "integration.observed",
      payload: {
        candidateCommit: "candidate",
        candidateRef: `refs/harness/candidate/${taskId}`,
        expectedRunHead: "run-head",
        patchId: "patch-id",
      },
    });
  }

  public eventsFor(
    eventType: HarnessEvent["eventType"],
    commandKey: string,
  ): HarnessEvent[] {
    return this.events.filter((event) => {
      if (event.eventType !== eventType) return false;
      if (event.eventType === "controller.command_received") {
        return event.payload.command.idempotencyKey === commandKey;
      }
      if (event.eventType === "controller.command_processed") {
        return event.payload.commandKey === commandKey;
      }
      return event.idempotencyKey === commandKey;
    });
  }

  public operatorIntents(operation: string, target: string): HarnessEvent[] {
    return this.events.filter(
      (event) =>
        event.eventType === "operator.intent" &&
        event.payload.operation === operation &&
        event.payload.target === target,
    );
  }

  public decisionBatch(commandKey: string): CommandDecisionBatch {
    const event = this.events.find(
      (candidate) =>
        candidate.eventType === "controller.command_decided" &&
        candidate.payload.commandKey === commandKey,
    );
    if (!event || event.eventType !== "controller.command_decided") {
      throw new Error(`missing decision batch ${commandKey}`);
    }
    return event.payload;
  }

  public derivationsFor(commandKey: string): number {
    return this.derivations.get(commandKey) ?? 0;
  }

  public sealedDecisionKeys(commandKey: string): string[] {
    const batch = this.decisionBatch(commandKey);
    return [
      ...batch.events.map(
        (event) => `event:${event.eventType}:${event.idempotencyKey}`,
      ),
      ...batch.effects.map((effect) => `effect:${effect.idempotencyKey}`),
    ].sort();
  }

  public appliedDecisionKeys(commandKey: string): string[] {
    const batch = this.decisionBatch(commandKey);
    const eventKeys = this.events
      .filter((event) =>
        batch.events.some(
          (draft) =>
            draft.eventType === event.eventType &&
            draft.idempotencyKey === event.idempotencyKey,
        ),
      )
      .map((event) => `event:${event.eventType}:${event.idempotencyKey}`);
    const effectKeys = this.events
      .filter(
        (event) =>
          event.eventType === "effect.intent" &&
          batch.effects.some(
            (effect) => effect.idempotencyKey === event.payload.idempotencyKey,
          ),
      )
      .map((event) =>
        event.eventType === "effect.intent"
          ? `effect:${event.payload.idempotencyKey}`
          : "",
      );
    return [...eventKeys, ...effectKeys].sort();
  }

  public multiDecisionOperatorCommand(key: string): ControllerCommand {
    return command("operator", key, { multi: true });
  }

  public async cleanup(): Promise<void> {
    await this.lease.release().catch(() => undefined);
    await this.cleanupRepo();
  }
}

export async function controllerQueueFixture(
  options: ControllerQueueFixtureOptions = {},
): Promise<ControllerQueueFixture> {
  const repo = await createTempRepoWithWorktree();
  const paths = await resolveRunPaths(repo.worktree, "F023");
  const lease = await RunLease.acquire(paths, "controller-fixture");
  return new ControllerQueueFixture(
    options,
    paths,
    new Journal(paths),
    lease,
    repo.cleanup,
  );
}

export async function runConcurrentWakeupRace(): Promise<{
  readonly maxConcurrentTransactions: number;
  readonly launchIntentCount: number;
}> {
  let active = 0;
  let maxConcurrentTransactions = 0;
  let launched = false;
  let launchIntentCount = 0;
  const processor: CommandQueueProcessor<ControllerCommand> = {
    accept: async (input) => ({ commandKey: input.idempotencyKey }),
    processReceived: async (commandKey) => {
      active += 1;
      maxConcurrentTransactions = Math.max(maxConcurrentTransactions, active);
      await Promise.resolve();
      if (!launched) {
        launched = true;
        launchIntentCount += 1;
      }
      active -= 1;
      return { commandKey, stateRevision: launchIntentCount };
    },
    pendingCommandKeysInSequenceOrder: async () => [],
  };
  const queue = new ControllerCommandQueue(processor);
  await Promise.all([
    queue.enqueue(command("timer", "a")),
    queue.enqueue(command("herdr", "b")),
    queue.enqueue(command("operator", "c")),
  ]);
  return { maxConcurrentTransactions, launchIntentCount };
}

interface RouteFixtureOverrides {
  readonly unavailable?: readonly WorkerKind[];
  readonly unauthenticated?: readonly WorkerKind[];
  readonly requirements?: readonly string[];
  readonly capabilities?: Partial<Record<WorkerKind, readonly string[]>>;
  readonly preference?: readonly WorkerKind[];
}

function workerProfiles(
  overrides: RouteFixtureOverrides,
): Record<WorkerKind, WorkerProfile> {
  const unauthenticated = new Set(overrides.unauthenticated ?? []);
  const make = (kind: WorkerKind): WorkerProfile => ({
    kind,
    authenticated: !unauthenticated.has(kind),
    available: true,
    capabilities: new Set(
      overrides.capabilities?.[kind] ?? ["sandbox", "superpowers"],
    ),
    concurrencyLimit: 2,
    active: 0,
  });
  return { codex: make("codex"), devin: make("devin"), claude: make("claude") };
}

export function routeFixture(
  overrides: RouteFixtureOverrides = {},
): WorkerSelection {
  return {
    preference: overrides.preference ?? ["devin", "codex", "claude"],
    profiles: workerProfiles(overrides),
    requirements: new Set(overrides.requirements ?? []),
    unavailable: new Set(overrides.unavailable ?? []),
  };
}

export function reviewFixture(
  overrides: RouteFixtureOverrides & { implementationWorker?: WorkerKind } = {},
): ReviewSelection {
  return {
    ...routeFixture({
      ...overrides,
      preference: overrides.preference ?? ["codex", "claude", "devin"],
    }),
    implementationWorker: overrides.implementationWorker ?? "devin",
  };
}

export const assignmentFixture = fixture<AssignmentInput>(() => ({
  runId: "F023",
  stageId: "implement",
  jobId: "implement:T001",
  itemKey: "T001",
  taskId: "T001",
  attempt: 1,
  role: "implementation",
  workerKind: "devin",
  commit: "abc123",
  allowedPaths: ["src/**", "test/**"],
  requiredDisciplines: [
    "test-driven-development",
    "verification-before-completion",
  ],
  verificationCommands: [["npm", "test"]],
  planningArtifacts: ["spec.md", "plan.md", "tasks.md"],
  worktree: {
    role: "implementation",
    path: "/tmp/harness-implementation",
    branch: "harness/F023-T001",
    commit: "abc123",
    writable: true,
  },
}));

export function reviewAssignment(
  overrides: DeepPartial<AssignmentInput> = {},
): WorkerAssignment {
  const base: AssignmentInput = {
    ...assignmentFixture(),
    stageId: "review",
    jobId: "review:T001",
    role: "review",
    workerKind: "codex",
    implementationWorkerKind: "devin",
    requiredDisciplines: ["requesting-code-review"],
    verificationCommands: [],
    worktree: {
      role: "review",
      path: "/tmp/harness-review",
      branch: null,
      commit: "abc123",
      writable: false,
    },
  };
  return createAssignment(deepMerge(base, overrides));
}

const evidenceHash = `sha256:${"b".repeat(64)}` as const;

export function approvedReview(
  overrides: Record<string, unknown> = {},
): JsonValue {
  return {
    schemaVersion: 1,
    assignmentHash: `sha256:${"a".repeat(64)}`,
    role: "review",
    outcome: "approved",
    reviewedCommit: "abc123",
    findings: [],
    evidence: [
      {
        kind: "superpower:requesting-code-review",
        path: ".harness-output/review.json",
        sha256: evidenceHash,
      },
    ],
    ...overrides,
  } as JsonValue;
}

interface FakeEvidenceGitOptions {
  readonly changed?: readonly string[];
  readonly status?: readonly string[];
  readonly worktreeCommit?: string;
}

export function fakeEvidenceGit(
  options: FakeEvidenceGitOptions = {},
): EvidenceGit {
  return {
    changedPaths: async () => options.changed ?? ["src/feature.ts"],
    worktreeStatus: async () => options.status ?? [],
    worktreeCommit: async () => options.worktreeCommit ?? "abc123",
  };
}

export function successfulFakeResults(): Readonly<Record<string, unknown>> {
  return {
    "command.run": { exitCode: 0 },
    "spec-kit.tasks": { graph: "accepted" },
    "worker.execute": { outcome: "completed" },
    "worker.review": { outcome: "approved" },
    "git.integrate": { candidateCommit: "candidate" },
    "git.project-task-status": { targetCommit: "target" },
    "git.push": { pushed: true },
    "github.pull-request": { url: "https://example.invalid/pr/1" },
  };
}

export function graphWithIndependentNonParallelTask(): TaskGraphDocument {
  const graph = structuredClone(diamondTaskGraph());
  graph.tasks[0]!.dependsOn = [];
  graph.tasks[0]!.parallelEligible = true;
  graph.tasks[1]!.dependsOn = [];
  graph.tasks[1]!.parallelEligible = false;
  graph.tasks[2]!.dependsOn = [];
  graph.tasks[2]!.parallelEligible = true;
  return graph;
}

export interface ControllerFixtureOptions {
  readonly graph?: TaskGraphDocument;
  readonly actionResults?: Readonly<Record<string, unknown>>;
  readonly crashAt?: CrashBoundary;
}

export class FakeControllerSystem {
  public readonly state;
  private hasRun = false;

  public constructor(
    private readonly scheduler: WorkflowScheduler,
    private readonly actions: FakeActionRegistry,
  ) {
    this.state = scheduler.state;
  }

  public get metrics() {
    return this.actions.metrics;
  }

  public async runToQuiescence(): Promise<void> {
    if (this.hasRun) return;
    this.hasRun = true;
    await this.scheduler.runToQuiescence(this.actions);
  }

  public async crashAndRestart(): Promise<void> {
    const first: SchedulerAction = {
      kind: "worker.execute",
      jobId: "implement:T001",
      stageId: "implement",
      taskId: "T001",
      attempt: 1,
      input: {},
    };
    try {
      await this.actions.execute(first);
    } catch (error) {
      if (!(error instanceof Error) || !/injected crash/.test(error.message)) {
        throw error;
      }
    }
    await this.actions.recover(first);
    await this.runToQuiescence();
  }

  public actionKinds(): string[] {
    return this.actions.actionKinds();
  }

  public executeCount(kind: string, identity: string): number {
    return this.actions.executeCount(kind, identity);
  }

  public observationCount(kind: string, identity: string): number {
    return this.actions.observationCount(kind, identity);
  }
}

export async function createControllerFixture(
  options: ControllerFixtureOptions = {},
): Promise<FakeControllerSystem> {
  const graph = options.graph ?? diamondTaskGraph();
  const validated = validateGraph(graph, fixtureGraphContextFor(graph));
  const workflow = compileWorkflow(fixtureCompileInput());
  return new FakeControllerSystem(
    new WorkflowScheduler(workflow, validated),
    new FakeActionRegistry(
      options.actionResults ?? successfulFakeResults(),
      options.crashAt,
    ),
  );
}
