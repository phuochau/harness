export interface PiProcessRecord {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly attemptToken: string;
  readonly executable: string;
  readonly argvHash: `sha256:${string}`;
  readonly cwd: string;
  readonly pid: number;
  readonly startIdentity: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly eventsPath: string;
  readonly stderrPath: string;
  readonly recordPath: string;
  readonly providerPath: string;
  readonly receiptPublicKey: string;
  readonly startedAt: string;
}

export interface PiProviderProcessRecord {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly startIdentity: string;
  readonly executable: string;
  readonly attemptToken: string;
  readonly signature: string;
}

export interface PiLaunchSpec {
  readonly attemptId: string;
  readonly attemptToken: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly controlDir?: string;
  readonly stdin?: Uint8Array;
}

export interface PiTerminalBoundary {
  readonly settled: boolean;
  readonly acceptedStopReason: boolean;
  readonly completeToolResults: boolean;
  readonly terminalEventHash?: `sha256:${string}`;
  readonly finalAssistantText?: string;
  readonly providerSession?: {
    readonly source: string;
    readonly id: string;
  };
}

export interface PiProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly terminal: PiTerminalBoundary;
}

export type PiProcessObservation =
  | { readonly status: "running"; readonly record: PiProcessRecord }
  | { readonly status: "exited"; readonly exit: PiProcessExit }
  | { readonly status: "missing" }
  | { readonly status: "identity_mismatch"; readonly evidence: readonly string[] };

export interface CancellationEvidence {
  readonly attemptId: string;
  readonly signals: readonly NodeJS.Signals[];
  readonly exit: PiProcessExit | null;
}

export interface PiProcessSupervisor {
  launch(spec: PiLaunchSpec): Promise<PiProcessRecord>;
  observe(record: PiProcessRecord): Promise<PiProcessObservation>;
  wait(record: PiProcessRecord, signal?: AbortSignal): Promise<PiProcessExit>;
  cancel(record: PiProcessRecord, graceMs?: number): Promise<CancellationEvidence>;
}
