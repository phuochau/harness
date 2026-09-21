import type { ProcessRunner } from "../../actions/types.js";
import type { WorkerAssignment } from "../../core/assignment.js";
import type { WorkerKind } from "../../core/routing.js";
import type { WorkerResult } from "../../contracts/worker-result.js";

export interface WorkerProbeContext {
  readonly cwd: string;
  readonly process: ProcessRunner;
  readonly env: Readonly<Record<string, string>>;
}

export interface WorkerCapabilities {
  readonly available: boolean;
  readonly launch: boolean;
  readonly nativeResume: boolean;
  readonly cancellation: "graceful" | "graceful_then_force" | "unavailable";
  readonly sandbox: boolean;
  readonly superpowers: boolean;
  readonly evidence: readonly string[];
}

export interface PreparedWorker {
  readonly assignment: WorkerAssignment;
  readonly prompt: string;
  readonly resultPath: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface HerdrAgentSpec {
  readonly kind: WorkerKind;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface NativeAgentSession {
  readonly source: string;
  readonly agent: string;
  readonly kind: "id" | "path";
  readonly value: string;
  readonly assignmentHash: string;
  readonly attempt: number;
}

export interface SupportedResumeSpec {
  readonly status: "supported";
  readonly session: NativeAgentSession;
  readonly assignmentHash: string;
  readonly args: readonly string[];
}

export interface UnsupportedResumeSpec {
  readonly status: "unsupported";
  readonly reason?: string;
}

export interface WorkerHandle {
  readonly agentName: string;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly assignmentHash: string;
  readonly attempt: number;
}

export interface HerdrCancellationSpec {
  readonly mode: "graceful" | "graceful_then_force" | "unavailable";
  readonly gracefulKeys: readonly string[];
  readonly timeoutMs: number;
  readonly forcePane: boolean;
}

export type ParsedWorkerResult =
  | { readonly status: "valid"; readonly result: WorkerResult }
  | { readonly status: "invalid"; readonly reason: string };

export interface WorkerAdapter {
  readonly kind: WorkerKind;
  probe(context: WorkerProbeContext): Promise<WorkerCapabilities>;
  prepare(assignment: WorkerAssignment): Promise<PreparedWorker>;
  launchSpec(prepared: PreparedWorker): HerdrAgentSpec;
  resumeSpec(
    prepared: PreparedWorker,
    session: NativeAgentSession,
  ): SupportedResumeSpec | UnsupportedResumeSpec;
  cancelSpec(handle: WorkerHandle): HerdrCancellationSpec;
  collect(prepared: PreparedWorker): Promise<ParsedWorkerResult>;
  parseResult(raw: string, assignment: WorkerAssignment): ParsedWorkerResult;
}

export type WorkerAdapterFactory = () => WorkerAdapter;

