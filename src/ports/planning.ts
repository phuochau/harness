import type {
  AcceptedStageArtifacts,
  ArtifactBaseline,
  ArtifactPaths,
  PlanningStage,
} from "../speckit/artifacts.js";
import type { PiProcessRecord } from "../runtime/pi-process/types.js";

export type PlanningCommand =
  | "/speckit.specify"
  | "/speckit.plan"
  | "/speckit.tasks";

export interface PlanningRequest {
  readonly stage: PlanningStage;
  readonly command: PlanningCommand;
  readonly correlationId: string;
  readonly artifactPaths: ArtifactPaths;
  readonly baseline: ArtifactBaseline;
}

export interface PlanningEnqueueContext {
  readonly instruction?: string;
}

export interface PlanningRunReceipt {
  readonly correlationId: string;
  readonly generation: number;
  readonly sessionFile: string;
  readonly requestEntryId: string;
  readonly profileId?: string;
  readonly profileHash?: string;
  readonly sessionId?: string;
  readonly sessionPath?: string;
  readonly attemptToken?: string;
  readonly process?: PiProcessRecord;
  readonly request?: PlanningRequest;
}

export interface PlanningAttemptReceipt {
  readonly profileId: string;
  readonly profileHash: string;
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly correlationId: string;
  readonly generation: number;
  readonly terminalEventHash: `sha256:${string}`;
  readonly beforeHashes: Readonly<Record<string, string | null>>;
  readonly afterHashes: Readonly<Record<string, string>>;
}

export type AcceptedPlanningArtifacts = AcceptedStageArtifacts & {
  readonly commit?: string;
};

export type PlanningObservation =
  | { readonly status: "pending" }
  | {
      readonly status: "completed";
      readonly correlationId: string;
      readonly artifacts: AcceptedPlanningArtifacts;
      readonly receipt?: PlanningAttemptReceipt;
    }
  | {
      readonly status: "blocked";
      readonly reason: string;
      readonly evidence: readonly string[];
    };

export interface PlanningAgent {
  prepare?(
    request: PlanningRequest,
    context?: PlanningEnqueueContext,
  ): Promise<PlanningRunReceipt>;
  launchPrepared?(receipt: PlanningRunReceipt): Promise<PlanningRunReceipt>;
  enqueue(
    request: PlanningRequest,
    context?: PlanningEnqueueContext,
  ): Promise<PlanningRunReceipt>;
  observe(receipt: PlanningRunReceipt): Promise<PlanningObservation>;
}

export interface PlanningArtifactSealer {
  sealPlanningArtifacts(
    hashes: Readonly<Record<string, string>>,
  ): Promise<{ readonly commit: string; readonly hashes: Readonly<Record<string, string>> }>;
}

export interface ExistingApprovedArtifactBinder {
  bindExistingApproved(
    paths: readonly string[],
    hashes: Readonly<Record<string, string>>,
  ): Promise<{ readonly commit: string }>;
}
