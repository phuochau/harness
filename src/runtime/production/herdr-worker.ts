import type { EffectIntent, ReconcileResult } from "../../actions/types.js";
import type { JsonValue } from "../../contracts/common.js";
import {
  validateWorkerResult,
  type WorkerResult,
} from "../../contracts/worker-result.js";
import type { WorkerAssignment } from "../../core/assignment.js";
import type { WorkerKind } from "../../core/routing.js";
import type { LifecycleWorktreeBinding } from "../../git/worktrees.js";
import {
  createAttemptIdentity,
  type AttemptIdentity,
} from "../herdr/identity.js";
import type {
  AssignmentSubmission,
  WorkerHandle,
  WorkerStartIntent,
  SubmitAssignmentIntent,
  WorkspaceHandle,
} from "../herdr/runtime.js";
import type { PreparedWorker, WorkerAdapter } from "../workers/types.js";
import type {
  PreparedWorkerAttempt,
  ProductionWorkerInput,
  ProductionWorkerKind,
  ProductionWorkerRuntime,
} from "./worker-action.js";

export interface PreparedAttemptBinding {
  readonly assignment: WorkerAssignment;
  readonly binding: LifecycleWorktreeBinding;
}

export interface ProductionWorkerAttemptPort {
  prepare(
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<PreparedAttemptBinding>;
  accept(
    assignment: WorkerAssignment,
    result: WorkerResult,
    binding: LifecycleWorktreeBinding,
  ): Promise<void>;
  release(binding: LifecycleWorktreeBinding): Promise<void>;
}

export interface ProductionHerdrPort {
  ensureWorkspace(input: {
    readonly worktreePath: string;
    readonly assignedCommit: string;
    readonly label: string;
    readonly branch?: string | null;
    readonly expectedWorkspaceId?: string;
    readonly expectedPaneId?: string;
  }): Promise<WorkspaceHandle>;
  startAgent(intent: WorkerStartIntent): Promise<WorkerHandle>;
  submitAssignment(intent: SubmitAssignmentIntent): Promise<AssignmentSubmission>;
  recoverSubmit(
    intent: SubmitAssignmentIntent,
  ): Promise<ReconcileResult<AssignmentSubmission>>;
  reconcile(intent: WorkerStartIntent): Promise<ReconcileResult<WorkerHandle>>;
  waitForAgent(handle: WorkerHandle, timeoutMs?: number): Promise<void>;
  closeWorkspace(workspaceId: string): Promise<void>;
}

interface PersistedPreparedAttempt {
  readonly schemaVersion: 1;
  readonly assignment: WorkerAssignment;
  readonly binding: LifecycleWorktreeBinding;
  readonly prompt: string;
  readonly resultPath: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly identity: AttemptIdentity;
  readonly args: readonly string[];
}

export interface HerdrProductionWorkerRuntimeOptions {
  readonly adapters: ReadonlyMap<WorkerKind, WorkerAdapter>;
  readonly herdr: ProductionHerdrPort;
  readonly attempts: ProductionWorkerAttemptPort;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePrepared(value: PreparedWorkerAttempt): PersistedPreparedAttempt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.assignment) ||
    !isRecord(value.binding) ||
    !isRecord(value.identity) ||
    typeof value.prompt !== "string" ||
    typeof value.resultPath !== "string" ||
    !isRecord(value.metadata) ||
    !Array.isArray(value.args) ||
    value.args.some((item: unknown) => typeof item !== "string")
  ) {
    throw new Error("invalid persisted worker attempt");
  }
  const assignment = value.assignment as unknown as WorkerAssignment;
  const binding = value.binding as unknown as LifecycleWorktreeBinding;
  const identity = value.identity as unknown as AttemptIdentity;
  if (
    !["codex", "devin", "claude"].includes(assignment.workerKind) ||
    assignment.assignmentHash !== identity.assignmentHash ||
    assignment.runId !== identity.runId ||
    assignment.jobId !== identity.jobId ||
    assignment.attempt !== identity.attempt ||
    assignment.workerKind !== identity.workerKind ||
    assignment.worktree.path !== binding.path ||
    binding.path !== identity.worktreePath ||
    binding.commit !== identity.assignedCommit
  ) {
    throw new Error("persisted worker attempt identity mismatch");
  }
  return value as unknown as PersistedPreparedAttempt;
}

function adapterFor(
  adapters: ReadonlyMap<WorkerKind, WorkerAdapter>,
  assignment: WorkerAssignment,
): WorkerAdapter {
  const adapter = adapters.get(assignment.workerKind);
  if (adapter === undefined) {
    throw new Error(`worker adapter is unavailable: ${assignment.workerKind}`);
  }
  return adapter;
}

function preparedWorker(value: PersistedPreparedAttempt): PreparedWorker {
  return {
    assignment: value.assignment,
    prompt: value.prompt,
    resultPath: value.resultPath,
    metadata: value.metadata,
  };
}

function startIntent(
  value: PersistedPreparedAttempt,
  intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
): WorkerStartIntent {
  return {
    action: "worker.start",
    idempotencyKey: `${intent.idempotencyKey}:start`,
    recovery: "reconcilable",
    laneKey: intent.laneKey,
    input: {
      identity: value.identity,
      agentName: value.identity.agentName,
      workerKind: value.assignment.workerKind,
      args: value.args,
    },
  };
}

function submitIntent(
  value: PersistedPreparedAttempt,
  intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
): SubmitAssignmentIntent {
  return {
    action: "worker.submit",
    idempotencyKey: `${intent.idempotencyKey}:submit`,
    recovery: "non_retryable",
    laneKey: intent.laneKey,
    input: {
      identity: value.identity,
      agentName: value.identity.agentName,
      prompt: value.prompt,
      resultPath: value.resultPath,
    },
  };
}

export class HerdrProductionWorkerRuntime implements ProductionWorkerRuntime {
  public constructor(private readonly options: HerdrProductionWorkerRuntimeOptions) {}

  public async prepare(
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<PreparedWorkerAttempt> {
    const { assignment, binding } = await this.options.attempts.prepare(intent);
    const adapter = adapterFor(this.options.adapters, assignment);
    const prepared = await adapter.prepare(assignment);
    const launch = adapter.launchSpec(prepared);
    if (launch.kind !== assignment.workerKind || launch.cwd !== binding.path) {
      throw new Error("worker launch specification escaped its assignment");
    }
    const workspace = await this.options.herdr.ensureWorkspace({
      worktreePath: binding.path,
      assignedCommit: binding.commit,
      label: `${assignment.runId}:${assignment.jobId}:a${assignment.attempt}`,
      branch: binding.branch,
    });
    const identity = createAttemptIdentity({
      runId: assignment.runId,
      jobId: assignment.jobId,
      ...(assignment.taskId === undefined ? {} : { taskId: assignment.taskId }),
      attempt: assignment.attempt,
      workerKind: assignment.workerKind,
      assignmentHash: assignment.assignmentHash,
      workspaceId: workspace.workspaceId,
      paneId: workspace.paneId,
      worktreePath: binding.path,
      assignedCommit: binding.commit,
    });
    return structuredClone({
      schemaVersion: 1,
      assignment,
      binding,
      prompt: prepared.prompt,
      resultPath: prepared.resultPath,
      metadata: prepared.metadata,
      identity,
      args: [...launch.args],
    }) as unknown as PreparedWorkerAttempt;
  }

  private async collect(
    value: PersistedPreparedAttempt,
  ): Promise<WorkerResult> {
    const collected = await adapterFor(this.options.adapters, value.assignment)
      .collect(preparedWorker(value));
    if (collected.status !== "valid") {
      throw new Error(`worker result is invalid: ${collected.reason}`);
    }
    const result = validateWorkerResult(collected.result);
    await this.options.attempts.accept(value.assignment, result, value.binding);
    return result;
  }

  public async execute(
    prepared: PreparedWorkerAttempt,
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<WorkerResult> {
    const value = parsePrepared(prepared);
    const handle = await this.options.herdr.startAgent(startIntent(value, intent));
    await this.options.herdr.submitAssignment(submitIntent(value, intent));
    await this.options.herdr.waitForAgent(handle, this.options.timeoutMs);
    return this.collect(value);
  }

  public async reconcile(
    prepared: PreparedWorkerAttempt,
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<ReconcileResult<WorkerResult>> {
    const value = parsePrepared(prepared);
    const submission = await this.options.herdr.recoverSubmit(submitIntent(value, intent));
    if (submission.status === "observed" && submission.output.result !== undefined) {
      const result = validateWorkerResult(submission.output.result);
      await this.options.attempts.accept(value.assignment, result, value.binding);
      return { status: "observed", output: result };
    }
    if (submission.status === "indeterminate") {
      const running = await this.options.herdr.reconcile(startIntent(value, intent));
      if (running.status === "observed") {
        await this.options.herdr.waitForAgent(running.output, this.options.timeoutMs);
        try {
          return { status: "observed", output: await this.collect(value) };
        } catch (error) {
          return {
            status: "indeterminate",
            evidence: [error instanceof Error ? error.message : String(error)],
          };
        }
      }
      return submission;
    }
    return {
      status: "indeterminate",
      evidence: ["prepared worker attempt has no durable submission result"],
    };
  }

  public async afterCompleted(
    prepared: PreparedWorkerAttempt,
    output: WorkerResult,
    _intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<void> {
    const value = parsePrepared(prepared);
    await this.options.herdr.closeWorkspace(value.identity.workspaceId);
    if (output.outcome === "blocked" || output.outcome === "failed") return;
    await this.options.attempts.release(value.binding);
  }
}
