import type {
  CommandDecisionBatch,
  EffectIntentPayload,
  RouteCause,
} from "../contracts/events.js";
import type { ControllerCommand } from "../contracts/controller-command.js";
import type { JsonValue } from "../contracts/common.js";
import type { TaskComplexity } from "../contracts/task-graph.js";
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

export interface AcceptedRoute {
  profileId: string;
  cause: RouteCause;
  tier?: TaskComplexity;
  complexity?: TaskComplexity;
  complexityReason?: string;
  candidates?: readonly string[];
  fixRound?: number;
}

export interface ImplementationLineageReview {
  readonly commit: string;
  readonly findings: readonly string[];
  readonly reviewedFixRound: number;
  readonly reviewEventKey: string;
}

export interface ImplementationLineage {
  readonly taskId: string;
  fixRound: number;
  generation: number;
  readonly originalProfileId: string;
  readonly originalTier: TaskComplexity;
  activeProfileId: string;
  activeTier: TaskComplexity;
  pendingReview?: ImplementationLineageReview;
  readonly acceptedReviews: ImplementationLineageReview[];
  dispatchKey?: string;
  globalAttemptSeq: number;
}

export interface JobState {
  state: JobStatus;
  attempt: number;
  firstAttemptAt?: string;
  worker?: string;
  route?: AcceptedRoute;
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
  stage?: "specify" | "plan" | "tasks" | "quick";
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
  implementationLineages: Record<string, ImplementationLineage>;
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
    implementationLineages: {},
    operator: { paused: false },
    planning: { status: "idle" },
  }) as RunState;
}
