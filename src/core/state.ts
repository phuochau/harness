import type {
  CommandDecisionBatch,
  EffectIntentPayload,
} from "../contracts/events.js";
import type { ControllerCommand } from "../contracts/controller-command.js";
import type { JsonValue } from "../contracts/common.js";
import type { WorkerResult } from "../contracts/worker-result.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { ZERO_HASH } from "../state/hash-chain.js";

export type JobStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "VERIFYING"
  | "RETRY"
  | "DONE"
  | "BLOCKED"
  | "FAILED";

export interface JobState {
  state: JobStatus;
  attempt: number;
  firstAttemptAt?: string;
  worker?: string;
  result?: WorkerResult;
  reviewCommit?: string;
  verificationCommit?: string;
  candidateCommit?: string;
  blocker?: JsonValue;
  failure?: string;
  retryReason?: "changes_requested" | "verification_failed" | "integration_conflict" | "task_failure";
}

export interface PendingCommand {
  readonly command: ControllerCommand;
  readonly receivedAt: string;
  readonly receivedSequence: number;
}

export interface PendingDecision {
  readonly batch: CommandDecisionBatch;
  readonly observedEvents: readonly string[];
  readonly observedEffects: readonly string[];
}

export interface PlanningState {
  status: "idle" | "pending" | "settled" | "completed" | "blocked";
  correlationId?: string;
  stage?: "specify" | "plan" | "tasks";
  finalTurnIndex?: number;
  hashes?: Readonly<Record<string, string>>;
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  workflowRevision: string;
  lastSequence: number;
  lastEventHash: string;
  jobs: Record<string, JobState>;
  pendingCommands: Record<string, PendingCommand>;
  pendingDecisions: Record<string, PendingDecision>;
  processedCommands: Record<string, number>;
  outstandingEffects: Record<string, EffectIntentPayload>;
  finalizedTasks: Record<
    string,
    { candidateCommit: string; targetCommit: string; tasksSemanticHash: string }
  >;
  integrationPipeline?: {
    taskId: string;
    status: "preparing_candidate" | "verifying_candidate";
  };
  operator: { paused: boolean; lastIntent?: string };
  planning: PlanningState;
}

export function initialRunState(runId: string, revision: string): RunState {
  return deepFreeze({
    schemaVersion: 1,
    runId,
    workflowRevision: revision,
    lastSequence: 0,
    lastEventHash: ZERO_HASH,
    jobs: {},
    pendingCommands: {},
    pendingDecisions: {},
    processedCommands: {},
    outstandingEffects: {},
    finalizedTasks: {},
    operator: { paused: false },
    planning: { status: "idle" },
  }) as RunState;
}
