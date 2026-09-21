import { join } from "node:path";
import type { WorkerAssignment } from "../../core/assignment.js";
import type { WorkerKind } from "../../core/routing.js";
import { buildWorkerPrompt } from "./prompt.js";
import { collectWorkerResult, parseWorkerResult } from "./result.js";
import { superpowersProfile } from "./superpowers-profile.js";
import type {
  HerdrAgentSpec,
  HerdrCancellationSpec,
  NativeAgentSession,
  ParsedWorkerResult,
  PreparedWorker,
  SupportedResumeSpec,
  UnsupportedResumeSpec,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerHandle,
  WorkerProbeContext,
} from "./types.js";

export interface WorkerDescriptor {
  readonly kind: WorkerKind;
  readonly executable: string;
  readonly versionArgs: readonly string[];
  readonly authArgs: readonly string[];
  readonly nativeResume: boolean;
  readonly sandbox: boolean;
  launchArgs(assignment: WorkerAssignment): readonly string[];
  resumeArgs(
    assignment: WorkerAssignment,
    session: NativeAgentSession,
  ): readonly string[];
}

export abstract class JsonResultWorkerAdapter implements WorkerAdapter {
  public abstract readonly kind: WorkerKind;
  protected abstract readonly descriptor: WorkerDescriptor;

  public async probe(context: WorkerProbeContext): Promise<WorkerCapabilities> {
    const version = await context.process.run(
      this.descriptor.executable,
      this.descriptor.versionArgs,
      { cwd: context.cwd, env: context.env, shell: false },
    );
    if (version.exitCode !== 0) {
      return {
        available: false,
        launch: false,
        nativeResume: this.descriptor.nativeResume,
        cancellation: "graceful_then_force",
        sandbox: this.descriptor.sandbox,
        superpowers: true,
        evidence: [`${this.kind} executable probe failed`],
      };
    }
    const authentication = await context.process.run(
      this.descriptor.executable,
      this.descriptor.authArgs,
      { cwd: context.cwd, env: context.env, shell: false },
    );
    const available = authentication.exitCode === 0;
    return {
      available,
      launch: available,
      nativeResume: this.descriptor.nativeResume,
      cancellation: "graceful_then_force",
      sandbox: this.descriptor.sandbox,
      superpowers: true,
      evidence: [
        `${this.kind} executable probe passed`,
        `${this.kind} authentication ${available ? "present" : "missing"}`,
      ],
    };
  }

  public async prepare(assignment: WorkerAssignment): Promise<PreparedWorker> {
    if (assignment.workerKind !== this.kind) {
      throw new Error(
        `assignment worker ${assignment.workerKind} does not match ${this.kind} adapter`,
      );
    }
    if (
      assignment.role === "review" &&
      assignment.scope === "task" &&
      assignment.implementationWorkerKind === this.kind
    ) {
      throw new Error("task review requires a different worker kind");
    }
    const profile = superpowersProfile(assignment);
    return {
      assignment,
      prompt: buildWorkerPrompt(assignment, profile),
      resultPath: join(
        assignment.worktree.path,
        ".harness-output",
        "result.json",
      ),
      metadata: {
        workerKind: this.kind,
        runId: assignment.runId,
        jobId: assignment.jobId,
        assignmentHash: assignment.assignmentHash,
        attempt: String(assignment.attempt),
        ...(assignment.taskId === undefined ? {} : { taskId: assignment.taskId }),
      },
    };
  }

  public launchSpec(prepared: PreparedWorker): HerdrAgentSpec {
    return {
      kind: this.kind,
      cwd: prepared.assignment.worktree.path,
      args: this.descriptor.launchArgs(prepared.assignment),
    };
  }

  public resumeSpec(
    prepared: PreparedWorker,
    session: NativeAgentSession,
  ): SupportedResumeSpec | UnsupportedResumeSpec {
    if (session.source !== `herdr:${this.kind}` || session.agent !== this.kind) {
      throw new Error(`session source does not match ${this.kind} adapter`);
    }
    if (session.assignmentHash !== prepared.assignment.assignmentHash) {
      throw new Error("session assignment hash mismatch");
    }
    if (session.attempt !== prepared.assignment.attempt) {
      throw new Error("session attempt generation mismatch");
    }
    if (!this.descriptor.nativeResume) {
      return { status: "unsupported", reason: `${this.kind} native resume is disabled` };
    }
    if (session.kind !== "id") {
      return {
        status: "unsupported",
        reason: `${this.kind} requires an official ID session reference`,
      };
    }
    return {
      status: "supported",
      session,
      assignmentHash: prepared.assignment.assignmentHash,
      args: this.descriptor.resumeArgs(prepared.assignment, session),
    };
  }

  public cancelSpec(_handle: WorkerHandle): HerdrCancellationSpec {
    return {
      mode: "graceful_then_force",
      gracefulKeys: ["ctrl+c"],
      timeoutMs: 30_000,
      forcePane: true,
    };
  }

  public collect(prepared: PreparedWorker): Promise<ParsedWorkerResult> {
    return collectWorkerResult(prepared);
  }

  public parseResult(
    raw: string,
    assignment: WorkerAssignment,
  ): ParsedWorkerResult {
    return parseWorkerResult(raw, assignment);
  }
}

