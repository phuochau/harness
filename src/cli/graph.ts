import type { JsonValue } from "../contracts/common.js";
import type { AcceptedRoute } from "../core/state.js";
import { loadRun, type RunOperationOptions } from "./status.js";

export interface RunGraphNode {
  readonly id: string;
  readonly state: string;
  readonly attempt: number;
  readonly worker?: string;
  readonly route?: AcceptedRoute;
  readonly blocker?: JsonValue;
}

export interface RunGraphView {
  readonly runId: string;
  readonly nodes: readonly RunGraphNode[];
  readonly activeLanes: readonly { readonly intentKey: string; readonly laneKey: string }[];
}

export async function graph(options: RunOperationOptions): Promise<RunGraphView> {
  const { state } = await loadRun(options);
  return {
    runId: state.runId,
    nodes: Object.entries(state.jobs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, job]) => ({
        id,
        state: job.state,
        attempt: job.attempt,
        ...(job.worker === undefined ? {} : { worker: job.worker }),
        ...(job.route === undefined ? {} : { route: job.route }),
        ...(job.blocker === undefined ? {} : { blocker: job.blocker }),
      })),
    activeLanes: Object.entries(state.outstandingEffects)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([intentKey, intent]) => ({ intentKey, laneKey: intent.laneKey })),
  };
}
