import type { HarnessEvent } from "../contracts/events.js";
import { initialRunState, type JobState, type RunState } from "../core/state.js";
import { reduceEvent } from "../core/reducer.js";
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

export interface StatusResult {
  readonly runId: string;
  readonly workflowRevision: string;
  readonly lastSequence: number;
  readonly paused: boolean;
  readonly planning: RunState["planning"];
  readonly jobs: Readonly<Record<string, JobState>>;
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
    outstandingEffects: Object.keys(state.outstandingEffects).sort(),
  };
}
