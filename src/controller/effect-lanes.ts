import type { EffectIntent } from "../actions/types.js";
import type { JsonValue } from "../contracts/common.js";
import type { RunState } from "../core/state.js";

export function reserveEffectLanes(
  state: RunState,
  candidates: readonly EffectIntent<string, JsonValue>[],
): readonly EffectIntent<string, JsonValue>[] {
  const occupied = new Set(
    Object.values(state.outstandingEffects).map((effect) => effect.laneKey),
  );
  if (state.integrationPipeline) {
    occupied.add(`integration-pipeline:${state.runId}`);
  }
  const reserved: EffectIntent<string, JsonValue>[] = [];
  for (const candidate of candidates) {
    if (occupied.has(candidate.laneKey)) continue;
    occupied.add(candidate.laneKey);
    reserved.push(candidate);
  }
  return reserved;
}
