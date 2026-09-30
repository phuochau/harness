import { taskIdForJob } from "./lifecycle.js";
import type { RunState } from "./state.js";

export function scopedAttemptKey(
  prefix: string,
  jobId: string,
  attempt: number,
  state: RunState,
): string {
  const taskId = taskIdForJob(jobId);
  const generation = taskId === undefined
    ? undefined
    : state.implementationLineages[taskId]?.generation;
  const base = `${prefix}:${jobId}:${attempt}`;
  return generation !== undefined && generation > 1
    ? `${base}:g${generation}`
    : base;
}

export function globalAttemptNumber(jobId: string, attempt: number, state: RunState): number {
  const taskId = taskIdForJob(jobId);
  const lineage = taskId === undefined ? undefined : state.implementationLineages[taskId];
  return lineage === undefined ? attempt : lineage.globalAttemptSeq + 1;
}
