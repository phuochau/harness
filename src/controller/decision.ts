import type { EffectIntent } from "../actions/types.js";
import type { JsonValue } from "../contracts/common.js";
import type { DecisionEventDraft } from "../contracts/events.js";
import type { MaterializedRunGraph } from "../core/materialize.js";
import type { RunState } from "../core/state.js";

export interface DecisionPolicy {
  readonly actionByStage: Readonly<Record<string, string>>;
  readonly maxNewEffects: number;
}

export interface DerivedDecisions {
  readonly events: readonly DecisionEventDraft[];
  readonly effects: readonly EffectIntent<string, JsonValue>[];
}

export function deriveDecisions(
  state: RunState,
  graph: MaterializedRunGraph,
  policy: DecisionPolicy,
): DerivedDecisions {
  const events: DecisionEventDraft[] = [];
  const effects: EffectIntent<string, JsonValue>[] = [];
  for (const job of Object.values(graph.jobs)) {
    const current = state.jobs[job.id]?.state ?? "PENDING";
    if (current !== "PENDING") continue;
    if (
      job.dependsOn.some(
        (dependency) => state.jobs[dependency]?.state !== "DONE",
      )
    ) {
      continue;
    }
    events.push({
      eventType: "job.ready",
      entityId: job.id,
      idempotencyKey: `ready:${job.id}`,
      payload: {},
    });
    const action = policy.actionByStage[job.stageId];
    if (action && effects.length < policy.maxNewEffects) {
      effects.push({
        action,
        idempotencyKey: `${action}:${job.id}:1`,
        recovery: "reconcilable",
        laneKey: action.startsWith("git.")
          ? `run-mutation:${state.runId}`
          : `worker:${job.id}`,
        input: { entityId: job.id, jobId: job.id, attempt: 1 },
      });
    }
  }
  return { events, effects };
}
