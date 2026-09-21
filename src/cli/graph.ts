import { loadRun, type RunOperationOptions } from "./status.js";

export interface RunGraphView {
  readonly runId: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly state: string;
    readonly attempt: number;
  }[];
  readonly activeLanes: readonly { readonly intentKey: string; readonly laneKey: string }[];
}

export async function graph(options: RunOperationOptions): Promise<RunGraphView> {
  const { state } = await loadRun(options);
  return {
    runId: state.runId,
    nodes: Object.entries(state.jobs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, job]) => ({ id, state: job.state, attempt: job.attempt })),
    activeLanes: Object.entries(state.outstandingEffects)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([intentKey, intent]) => ({ intentKey, laneKey: intent.laneKey })),
  };
}
