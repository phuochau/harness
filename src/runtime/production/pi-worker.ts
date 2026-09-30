import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { EffectIntent, ReconcileResult } from "../../actions/types.js";
import type { ResolvedProfile, ResolvedProfiles } from "../../config/profiles.js";
import type { HandoffReference, WorkerAssignment } from "../../core/assignment.js";
import { validateWorkerResult, type WorkerResult } from "../../contracts/worker-result.js";
import type { ProfileFamily } from "../../contracts/profiles.js";
import type { LifecycleWorktreeBinding } from "../../git/worktrees.js";
import { sha256 } from "../../shared/sha256.js";
import type { PiProcessRecord } from "../pi-process/types.js";
import type { TaskSessionStore } from "../pi-worker/task-session.js";
import type { Journal } from "../../state/journal.js";
import { buildHandoffReport, verifyHandoffReport, writeHandoffReport } from "../workers/handoff-report.js";
import {
  PiWorkerRuntime,
  type PreparedPiAttempt,
  type RecoveryDecision,
} from "../pi-worker/runtime.js";
import type { DurableRecordStore } from "./records.js";
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
    handoffReport?: HandoffReference,
  ): Promise<PreparedAttemptBinding>;
  stagePrompt(binding: LifecycleWorktreeBinding, prompt: string): Promise<string>;
  accept(
    assignment: WorkerAssignment,
    result: WorkerResult,
    binding: LifecycleWorktreeBinding,
  ): Promise<void>;
  release(binding: LifecycleWorktreeBinding): Promise<void>;
  abort(binding: LifecycleWorktreeBinding): Promise<void>;
}

export interface PersistedPreparedPiAttempt {
  readonly schemaVersion: 1;
  readonly assignment: WorkerAssignment;
  readonly binding: LifecycleWorktreeBinding;
  readonly profile: {
    readonly id: string;
    readonly family: ProfileFamily;
    readonly hash: string;
  };
  readonly prompt: string;
  readonly resultPath: string;
  readonly attemptId: string;
  readonly launch: PreparedPiAttempt["launch"];
  readonly managedSession?: { readonly taskId: string; readonly generation: number };
}

export interface ProductionPiWorkerRuntimeOptions {
  readonly runtime: PiWorkerRuntime;
  readonly profiles: ResolvedProfiles;
  readonly attempts: ProductionWorkerAttemptPort;
  readonly records: DurableRecordStore;
  readonly processRoot: string;
  readonly sessions?: TaskSessionStore;
  readonly journal?: Journal;
  readonly handoffRoot?: string;
}

export class SessionContinuationBlockedError extends Error {
  public readonly code = "SESSION_CONTINUATION_BLOCKED";

  public constructor(reason: string) {
    super(`session_continuation_blocked: ${reason}`);
  }
}

export class HandoffReportBlockedError extends Error {
  public readonly code = "HANDOFF_REPORT_BLOCKED";

  public constructor(reason: string) {
    super(`handoff_report_blocked: ${reason}`);
  }
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvedProfile(
  profiles: ResolvedProfiles,
  summary: PersistedPreparedPiAttempt["profile"],
): ResolvedProfile {
  const profile = profiles.byId[summary.id];
  if (
    profile === undefined ||
    profile.family !== summary.family ||
    profile.hash !== summary.hash
  ) {
    throw new Error("persisted worker profile identity mismatch");
  }
  return profile;
}

function attemptControlDir(processRoot: string, attemptId: string): string {
  return join(processRoot, sha256(attemptId).slice("sha256:".length));
}

async function prepareReceiptKey(controlDir: string): Promise<{
  receiptPrivateKeyPath: string;
  receiptPublicKey: string;
}> {
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  const receiptPrivateKeyPath = join(controlDir, "receipt-private.pem");
  const { privateKey: generated } = generateKeyPairSync("ed25519");
  const generatedKey = generated.export({ type: "pkcs8", format: "pem" }).toString();
  const temporary = `${receiptPrivateKeyPath}.tmp-${process.pid}-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(generatedKey, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, receiptPrivateKeyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directory = await open(controlDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const info = await lstat(receiptPrivateKeyPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024) {
    throw new Error("prepared Pi receipt private key is not a bounded regular file");
  }
  const privateKey = await readFile(receiptPrivateKeyPath, "utf8");
  const receiptPublicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" }).toString();
  return { receiptPrivateKeyPath, receiptPublicKey };
}

function parsePrepared(
  value: PreparedWorkerAttempt,
  profiles: ResolvedProfiles,
  processRoot: string,
): PersistedPreparedPiAttempt {
  if (
    !record(value) || value.schemaVersion !== 1 ||
    !record(value.assignment) || !record(value.binding) || !record(value.profile) ||
    !record(value.launch) || typeof value.prompt !== "string" ||
    typeof value.resultPath !== "string" || typeof value.attemptId !== "string"
  ) throw new Error("invalid persisted Pi worker attempt");
  const parsed = value as unknown as PersistedPreparedPiAttempt;
  const profile = resolvedProfile(profiles, parsed.profile);
  if (
    parsed.assignment.profileId !== profile.id ||
    parsed.assignment.profileFamily !== profile.family ||
    parsed.assignment.worktree.path !== parsed.binding.path ||
    parsed.binding.commit !== parsed.assignment.commit ||
    parsed.launch.attemptId !== parsed.attemptId ||
    parsed.launch.cwd !== parsed.binding.path ||
    parsed.launch.controlDir !== attemptControlDir(processRoot, parsed.attemptId) ||
    parsed.launch.receiptPrivateKeyPath !== join(
      attemptControlDir(processRoot, parsed.attemptId),
      "receipt-private.pem",
    ) ||
    typeof parsed.launch.receiptPublicKey !== "string" ||
    parsed.launch.receiptPublicKey.length === 0 ||
    (parsed.managedSession !== undefined && (
      !record(parsed.managedSession) ||
      parsed.managedSession.taskId !== parsed.assignment.taskId ||
      !Number.isInteger(parsed.managedSession.generation) ||
      parsed.managedSession.generation < 1
    )) ||
    !parsed.resultPath.startsWith(`${parsed.binding.path}/.harness-output/`) ||
    parsed.launch.controlDir.startsWith(`${parsed.binding.path}/`)
  ) throw new Error("persisted Pi worker attempt identity mismatch");
  return parsed;
}

function runtimePrepared(
  value: PersistedPreparedPiAttempt,
  profiles: ResolvedProfiles,
): PreparedPiAttempt {
  return {
    attemptId: value.attemptId,
    assignment: value.assignment,
    profile: resolvedProfile(profiles, value.profile),
    launch: value.launch,
    prompt: value.prompt,
    resultPath: value.resultPath,
  };
}

function validateProcessRecord(
  value: unknown,
  prepared: PersistedPreparedPiAttempt,
): PiProcessRecord {
  if (
    !record(value) || value.schemaVersion !== 1 ||
    value.attemptId !== prepared.attemptId ||
    value.attemptToken !== prepared.launch.attemptToken ||
    value.cwd !== prepared.launch.cwd ||
    value.sessionId !== prepared.launch.sessionId ||
    value.sessionDir !== prepared.launch.sessionDir ||
    typeof value.pid !== "number" || typeof value.startIdentity !== "string" ||
    typeof value.executable !== "string" || typeof value.argvHash !== "string" ||
    typeof value.eventsPath !== "string" || typeof value.stderrPath !== "string" ||
    typeof value.recordPath !== "string" || typeof value.providerPath !== "string" ||
    typeof value.receiptPublicKey !== "string" || typeof value.startedAt !== "string" ||
    value.receiptPublicKey !== prepared.launch.receiptPublicKey ||
    value.recordPath !== join(prepared.launch.controlDir ?? prepared.launch.sessionDir, "process.json") ||
    value.providerPath !== join(prepared.launch.controlDir ?? prepared.launch.sessionDir, "provider.json") ||
    value.eventsPath !== join(prepared.launch.controlDir ?? prepared.launch.sessionDir, "events.jsonl") ||
    value.stderrPath !== join(prepared.launch.controlDir ?? prepared.launch.sessionDir, "stderr.log")
  ) throw new Error("invalid or mismatched Pi process record");
  return value as PiProcessRecord;
}

export class ProductionPiWorkerRuntime implements ProductionWorkerRuntime {
  private readonly launches = new Map<string, Promise<PiProcessRecord>>();

  public constructor(private readonly options: ProductionPiWorkerRuntimeOptions) {}

  private async acquireSessionWriter(value: PersistedPreparedPiAttempt): Promise<void> {
    if (value.managedSession === undefined || this.options.sessions === undefined) return;
    const selected = await this.options.sessions.acquireWriter(
      value.managedSession.taskId,
      value.attemptId,
      { generation: value.managedSession.generation, profileId: value.assignment.profileId },
    );
    if (selected.status === "blocked") {
      throw new SessionContinuationBlockedError(selected.reason);
    }
  }

  private async releaseSessionWriter(value: PersistedPreparedPiAttempt): Promise<void> {
    if (value.managedSession === undefined || this.options.sessions === undefined) return;
    await this.options.sessions.releaseWriter(
      value.managedSession.taskId,
      value.attemptId,
      { generation: value.managedSession.generation },
    );
  }

  private async cleanupProcess(value: PersistedPreparedPiAttempt): Promise<void> {
    const process = await this.processRecord(value);
    if (process !== undefined) {
      await this.options.runtime.cancel({ attemptId: value.attemptId, process });
    }
  }

  private launchOnce(prepared: PreparedPiAttempt): Promise<PiProcessRecord> {
    const existing = this.launches.get(prepared.attemptId);
    if (existing !== undefined) return existing;
    const launch = (async () => {
      const handle = await this.options.runtime.launch(prepared);
      return this.options.records.putPiProcess(handle.process);
    })().finally(() => this.launches.delete(prepared.attemptId));
    this.launches.set(prepared.attemptId, launch);
    return launch;
  }

  public async prepare(
    intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<PreparedWorkerAttempt> {
    let handoffReport: HandoffReference | undefined;
    if (intent.action === "worker.execute" && typeof intent.input.fixRound === "number" &&
        intent.input.fixRound > 0 && typeof intent.input.taskId === "string" &&
        this.options.journal !== undefined && this.options.handoffRoot !== undefined) {
      try {
        const built = buildHandoffReport(await this.options.journal.read(), intent.input.taskId);
        const path = join(
          this.options.handoffRoot,
          intent.input.taskId,
          `round-${intent.input.fixRound}-${built.hash.slice(7, 23)}.json`,
        );
        await writeHandoffReport(path, built);
        await verifyHandoffReport(path, built.hash);
        handoffReport = { path, hash: built.hash, previousCommit: built.report.previousCommit };
      } catch (error) {
        throw new HandoffReportBlockedError(error instanceof Error ? error.message : "report unavailable");
      }
    }
    const { assignment, binding } = await this.options.attempts.prepare(intent, handoffReport);
    let session: {
      readonly sessionId: string;
      readonly sessionDir: string;
      readonly resumeTranscriptPath?: string;
    } | undefined;
    let managedSession: { readonly taskId: string; readonly generation: number } | undefined;
    if (intent.action === "worker.execute" && this.options.sessions !== undefined &&
        typeof intent.input.fixRound === "number" &&
        typeof intent.input.localAttempt === "number" && assignment.taskId !== undefined) {
      const fixRound = intent.input.fixRound;
      const localAttempt = intent.input.localAttempt;
      if (!Number.isInteger(fixRound) || fixRound < 0 || fixRound > 5 ||
          !Number.isInteger(localAttempt) || localAttempt < 1) {
        throw new Error("invalid implementation session selection");
      }
      const generation = fixRound >= 4 ? fixRound + 1 : 1;
      managedSession = { taskId: assignment.taskId, generation };
      const selector = { generation, profileId: assignment.profileId };
      if (localAttempt === 1 && (fixRound === 0 || fixRound >= 4)) {
        const created = await this.options.sessions.create({ taskId: assignment.taskId, ...selector });
        session = { sessionId: created.sessionId, sessionDir: created.sessionDir };
      } else {
        const checked = await this.options.sessions.verify(assignment.taskId, selector);
        if (checked.status === "blocked" || checked.session.transcriptPath === undefined) {
          throw new SessionContinuationBlockedError(
            checked.status === "blocked" ? checked.reason : "transcript_missing",
          );
        }
        session = {
          sessionId: checked.session.sessionId,
          sessionDir: checked.session.sessionDir,
          resumeTranscriptPath: checked.session.transcriptPath,
        };
      }
    }
    const prepared = await this.options.runtime.prepare(assignment, session);
    const controlDir = attemptControlDir(this.options.processRoot, prepared.attemptId);
    const receiptKey = await prepareReceiptKey(controlDir);
    const launch = {
      ...prepared.launch,
      controlDir,
      ...receiptKey,
    };
    await this.options.attempts.stagePrompt(binding, prepared.prompt);
    return structuredClone({
      schemaVersion: 1,
      assignment,
      binding,
      profile: {
        id: prepared.profile.id,
        family: prepared.profile.family,
        hash: prepared.profile.hash,
      },
      prompt: prepared.prompt,
      resultPath: prepared.resultPath,
      attemptId: prepared.attemptId,
      launch,
      ...(managedSession === undefined ? {} : { managedSession }),
    }) as unknown as PreparedWorkerAttempt;
  }

  private async processRecord(
    prepared: PersistedPreparedPiAttempt,
  ): Promise<PiProcessRecord | undefined> {
    const durable = await this.options.records.getPiProcess(prepared.attemptId);
    if (durable !== undefined) return validateProcessRecord(durable, prepared);
    try {
      const processPath = `${prepared.launch.controlDir ?? prepared.launch.sessionDir}/process.json`;
      const info = await lstat(processPath);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
        throw new Error("Pi process recovery record is not a bounded regular file");
      }
      const recovered = validateProcessRecord(
        JSON.parse(await readFile(processPath, "utf8")),
        prepared,
      );
      return this.options.records.putPiProcess(recovered);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private interrupted(
    assignment: WorkerAssignment,
    reason: string,
  ): WorkerResult {
    return {
      schemaVersion: 1,
      assignmentHash: assignment.assignmentHash,
      outcome: "failed",
      reason,
      evidence: [],
    };
  }

  private async acceptParsed(
    value: PersistedPreparedPiAttempt,
    parsed: Awaited<ReturnType<PiWorkerRuntime["collect"]>>,
  ): Promise<WorkerResult> {
    if (parsed.status !== "valid") {
      throw new Error(`worker result is invalid: ${parsed.reason}`);
    }
    const result = validateWorkerResult(parsed.result);
    await this.options.attempts.accept(value.assignment, result, value.binding);
    return result;
  }

  private async resolveRecovery(
    value: PersistedPreparedPiAttempt,
    prepared: PreparedPiAttempt,
    decision: RecoveryDecision,
  ): Promise<ReconcileResult<WorkerResult>> {
    if (decision.status === "indeterminate") {
      return { status: "indeterminate", evidence: decision.evidence };
    }
    if (decision.status === "observed") {
      const result = validateWorkerResult(decision.result);
      await this.options.attempts.accept(value.assignment, result, value.binding);
      return { status: "observed", output: result };
    }
    if (decision.status === "running") {
      try {
        return {
          status: "observed",
          output: await this.acceptParsed(value, await this.options.runtime.collect(prepared)),
        };
      } catch (error) {
        return {
          status: "indeterminate",
          evidence: [error instanceof Error ? error.message : String(error)],
        };
      }
    }
    const reason = decision.status === "retry"
      ? decision.reason
      : `provider session ${decision.sessionId} requires a new attempt`;
    const result = this.interrupted(value.assignment, reason);
    await this.options.attempts.accept(value.assignment, result, value.binding);
    return { status: "observed", output: result };
  }

  public async execute(
    persisted: PreparedWorkerAttempt,
    _intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<WorkerResult> {
    const value = parsePrepared(persisted, this.options.profiles, this.options.processRoot);
    const prepared = runtimePrepared(value, this.options.profiles);
    const existing = await this.processRecord(value);
    if (existing !== undefined) {
      const decision = await this.options.runtime.recover(prepared, {
        attemptId: prepared.attemptId,
        process: existing,
      });
      const reconciled = await this.resolveRecovery(value, prepared, decision);
      if (reconciled.status !== "observed") {
        throw new Error(
          reconciled.status === "indeterminate"
            ? `worker process cannot be resumed: ${reconciled.evidence.join("; ")}`
            : "worker process cannot be resumed",
        );
      }
      return reconciled.output;
    }
    try {
      await this.acquireSessionWriter(value);
      await this.launchOnce(prepared);
    } catch (error) {
      const recovered = await this.processRecord(value);
      if (recovered === undefined) throw error;
      const decision = await this.options.runtime.recover(prepared, {
        attemptId: prepared.attemptId,
        process: recovered,
      });
      const reconciled = await this.resolveRecovery(value, prepared, decision);
      if (reconciled.status !== "observed") throw error;
      return reconciled.output;
    }
    return this.acceptParsed(value, await this.options.runtime.collect(prepared));
  }

  public async reconcile(
    persisted: PreparedWorkerAttempt,
    _intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<ReconcileResult<WorkerResult>> {
    const value = parsePrepared(persisted, this.options.profiles, this.options.processRoot);
    const process = await this.processRecord(value);
    if (process === undefined) return { status: "not_found" };
    const prepared = runtimePrepared(value, this.options.profiles);
    return this.resolveRecovery(
      value,
      prepared,
      await this.options.runtime.recover(prepared, {
        attemptId: prepared.attemptId,
        process,
      }),
    );
  }

  public async afterCompleted(
    persisted: PreparedWorkerAttempt,
    output: WorkerResult,
  ): Promise<void> {
    const value = parsePrepared(persisted, this.options.profiles, this.options.processRoot);
    await this.cleanupProcess(value);
    await this.releaseSessionWriter(value);
    if (output.outcome === "blocked" || output.outcome === "failed") {
      await this.options.attempts.abort(value.binding);
    } else {
      await this.options.attempts.release(value.binding);
    }
  }

  public async abort(
    persisted: PreparedWorkerAttempt,
    _intent: EffectIntent<ProductionWorkerKind, ProductionWorkerInput>,
  ): Promise<void> {
    const value = parsePrepared(persisted, this.options.profiles, this.options.processRoot);
    await this.cleanupProcess(value);
    await this.releaseSessionWriter(value);
    await this.options.attempts.abort(value.binding);
  }
}
