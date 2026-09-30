import type { HarnessEvent, RouteCause } from "../contracts/events.js";
import type { JsonValue } from "../contracts/common.js";
import type { TaskComplexity } from "../contracts/task-graph.js";
import {
  initialRunState,
  type ImplementationLineage,
  type JobState,
  type RunState,
} from "../core/state.js";
import { reduceEvent } from "../core/reducer.js";
import { taskIdForJob } from "../core/lifecycle.js";
import { Journal } from "../state/journal.js";
import { resolveRunPaths } from "../state/paths.js";
import type { RunPaths } from "../state/types.js";

export interface RunOperationOptions {
  readonly root: string;
  readonly runId: string;
}

export interface LoadedRun {
  readonly paths: RunPaths;
  readonly events: readonly HarnessEvent[];
  readonly state: RunState;
}

export function replayRunEvents(events: readonly HarnessEvent[], runId: string): RunState {
  const created = events.find((event) => event.eventType === "run.created");
  if (created === undefined || created.runId !== runId) {
    throw new Error(`run ${runId} has no valid run.created boundary`);
  }
  let state = initialRunState(runId, created.payload.workflowRevision);
  for (const event of events) state = reduceEvent(state, event);
  return state;
}

export async function loadRun(options: RunOperationOptions): Promise<LoadedRun> {
  const paths = await resolveRunPaths(options.root, options.runId);
  const events = await new Journal(paths).read();
  return { paths, events, state: replayRunEvents(events, options.runId) };
}

export interface TaskRoutingBlock {
  readonly jobId: string;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly suggestedChange?: string;
}

export interface TaskRoutingView {
  readonly taskId: string;
  readonly complexity?: TaskComplexity;
  readonly complexityReason?: string;
  readonly candidates?: readonly string[];
  readonly profileId?: string;
  readonly tier?: TaskComplexity;
  readonly cause?: RouteCause;
  readonly fixRound?: number;
  readonly generation?: number;
  readonly pendingFindings?: readonly string[];
  readonly pendingReviewCommit?: string;
  readonly block?: TaskRoutingBlock;
}

function routingBlock(jobId: string, blocker: JsonValue): TaskRoutingBlock {
  const record =
    typeof blocker === "object" && blocker !== null && !Array.isArray(blocker)
      ? (blocker as Record<string, JsonValue>)
      : {};
  const suggestedChange =
    typeof record.suggestedChange === "string" ? record.suggestedChange : undefined;
  return {
    jobId,
    reason: typeof record.reason === "string" ? record.reason : "blocked",
    evidence: Array.isArray(record.evidence)
      ? record.evidence.filter((item): item is string => typeof item === "string")
      : [],
    ...(suggestedChange === undefined ? {} : { suggestedChange }),
  };
}

function taskRoutingViews(state: RunState): Record<string, TaskRoutingView> {
  const taskIds = new Set<string>(Object.keys(state.implementationLineages));
  for (const jobId of Object.keys(state.jobs)) {
    const taskId = taskIdForJob(jobId);
    if (taskId !== undefined) taskIds.add(taskId);
  }
  const views: Record<string, TaskRoutingView> = {};
  for (const taskId of [...taskIds].sort()) {
    const lineage: ImplementationLineage | undefined =
      state.implementationLineages[taskId];
    const implement = state.jobs[`implement:${taskId}`];
    const route = implement?.route;
    const initialBlock = implement?.blocker !== undefined &&
      typeof implement.blocker === "object" && !Array.isArray(implement.blocker)
        ? implement.blocker as Record<string, JsonValue>
        : undefined;
    const blocked = Object.entries(state.jobs)
      .filter(
        ([jobId, job]) =>
          taskIdForJob(jobId) === taskId &&
          job.state === "BLOCKED" &&
          job.blocker !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))[0];
    const pending = lineage?.pendingReview;
    const profileId =
      lineage?.activeProfileId ?? route?.profileId ?? implement?.worker;
    const tier = lineage?.activeTier ?? route?.tier;
    const fixRound = lineage?.fixRound ?? route?.fixRound;
    const view: TaskRoutingView = {
      taskId,
      ...(route?.complexity === undefined && typeof initialBlock?.complexity !== "string"
        ? {}
        : { complexity: (route?.complexity ?? initialBlock?.complexity) as TaskComplexity }),
      ...(route?.complexityReason === undefined && typeof initialBlock?.complexityReason !== "string"
        ? {}
        : { complexityReason: (route?.complexityReason ?? initialBlock?.complexityReason) as string }),
      ...(route?.candidates === undefined && !Array.isArray(initialBlock?.candidates)
        ? {}
        : { candidates: (route?.candidates ?? initialBlock?.candidates) as string[] }),
      ...(profileId === undefined ? {} : { profileId }),
      ...(tier === undefined ? {} : { tier }),
      ...(route?.cause === undefined ? {} : { cause: route.cause }),
      ...(fixRound === undefined ? {} : { fixRound }),
      ...(lineage?.generation === undefined
        ? {}
        : { generation: lineage.generation }),
      ...(pending === undefined
        ? {}
        : {
            pendingFindings: pending.findings,
            pendingReviewCommit: pending.commit,
          }),
      ...(blocked === undefined
        ? {}
        : { block: routingBlock(blocked[0], blocked[1].blocker!) }),
    };
    views[taskId] = view;
  }
  return views;
}

export interface StatusResult {
  readonly runId: string;
  readonly workflowRevision: string;
  readonly lastSequence: number;
  readonly paused: boolean;
  readonly planning: RunState["planning"];
  readonly jobs: Readonly<Record<string, JobState>>;
  readonly tasks: Readonly<Record<string, TaskRoutingView>>;
  readonly implementationLineages: RunState["implementationLineages"];
  readonly outstandingEffects: readonly string[];
}

export async function status(options: RunOperationOptions): Promise<StatusResult> {
  const { state } = await loadRun(options);
  return {
    runId: state.runId,
    workflowRevision: state.workflowRevision,
    lastSequence: state.lastSequence,
    paused: state.operator.paused,
    planning: state.planning,
    jobs: state.jobs,
    tasks: taskRoutingViews(state),
    implementationLineages: state.implementationLineages,
    outstandingEffects: Object.keys(state.outstandingEffects).sort(),
  };
}
