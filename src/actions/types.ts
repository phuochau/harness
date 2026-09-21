import type { JsonValue } from "../contracts/common.js";
import type { RecoveryClass } from "../contracts/events.js";

export type { RecoveryClass };

export interface EffectIntent<K extends string = string, I = unknown> {
  readonly action: K;
  readonly idempotencyKey: string;
  readonly recovery: RecoveryClass;
  readonly laneKey: string;
  readonly input: I;
}

export type ReconcileResult<O> =
  | { readonly status: "not_found" }
  | { readonly status: "observed"; readonly output: O }
  | { readonly status: "indeterminate"; readonly evidence: readonly string[] };

export interface ProcessRunner {
  run(
    executable: string,
    argv: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly stdin?: Uint8Array;
      readonly shell: false;
      readonly timeoutMs?: number;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  runBytes(
    executable: string,
    argv: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly stdin?: Uint8Array;
      readonly shell: false;
      readonly timeoutMs?: number;
    },
  ): Promise<{ exitCode: number; stdout: Uint8Array; stderr: string }>;
}

export interface SealedImplementation {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly sourceTree: string;
  readonly patchId: string;
  readonly changedPaths: readonly string[];
}

export interface GitPort {
  patchIdForRange(base: string, head: string): Promise<string>;
  findCommitByTrailer(
    branch: string,
    key: string,
    value: string,
  ): Promise<string | undefined>;
  assertIntegrationMetadata(
    commit: string,
    identity: {
      effectKey: string;
      expectedRunHead: string;
      change: SealedImplementation;
    },
  ): Promise<void>;
  assertWorktreeCommit(path: string, expectedCommit: string): Promise<void>;
  commitTree(
    tree: string,
    input: { parent: string; trailers: Readonly<Record<string, string>> },
  ): Promise<string>;
  updateRefCas(ref: string, next: string, expected: string): Promise<void>;
  revParse(ref: string): Promise<string>;
  revParseOptional(ref: string): Promise<string | undefined>;
  status(path: string): Promise<readonly string[]>;
}

export interface ApprovalStore {
  get(
    requestId: string,
  ): Promise<
    | { approved: boolean; actor: string; recordedAt: string }
    | undefined
  >;
}

export interface Clock {
  now(): Date;
}

export interface ActionContext {
  readonly isRecovery: boolean;
  readonly process: ProcessRunner;
  readonly git: GitPort;
  readonly approvals: ApprovalStore;
  readonly clock: Clock;
  readonly signal: AbortSignal;
}

export interface ActionDependencies {
  readonly process: ProcessRunner;
  readonly git: GitPort;
  readonly approvals: ApprovalStore;
  readonly clock: Clock;
  readonly signal: AbortSignal;
}

export interface ActionHandler<
  K extends string = string,
  I = JsonValue,
  O = JsonValue,
> {
  readonly kind: K;
  recovery(input: I): RecoveryClass;
  execute(
    context: ActionContext,
    intent: EffectIntent<K, I>,
  ): Promise<O>;
  reconcile(
    context: ActionContext,
    intent: EffectIntent<K, I>,
  ): Promise<ReconcileResult<O>>;
}
