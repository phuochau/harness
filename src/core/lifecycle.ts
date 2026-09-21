import type { HarnessEvent } from "../contracts/events.js";
import type { JobState, JobStatus, RunState } from "./state.js";

export class LifecycleError extends Error {}

export function ensureJob(state: RunState, jobId: string): JobState {
  return (state.jobs[jobId] ??= { state: "PENDING", attempt: 0 });
}

export function transitionJob(
  state: RunState,
  jobId: string,
  from: JobStatus | readonly JobStatus[],
  to: JobStatus,
): JobState {
  const job = ensureJob(state, jobId);
  const allowed = Array.isArray(from) ? from : [from];
  if (!allowed.includes(job.state)) {
    throw new LifecycleError(
      `illegal job transition ${jobId}: ${job.state} -> ${to}`,
    );
  }
  job.state = to;
  return job;
}

export function startAttempt(state: RunState, event: HarnessEvent): void {
  if (event.eventType !== "attempt.started") return;
  const job = transitionJob(state, event.entityId, ["READY", "RETRY"], "RUNNING");
  if (event.payload.attempt !== job.attempt + 1) {
    throw new LifecycleError(`attempt sequence mismatch for ${event.entityId}`);
  }
  job.attempt = event.payload.attempt;
  job.worker = event.payload.worker;
}

export function taskIdForJob(jobId: string): string | undefined {
  const separator = jobId.lastIndexOf(":");
  if (separator < 0) return undefined;
  const taskId = jobId.slice(separator + 1);
  return /^T[0-9]{3,}$/.test(taskId) ? taskId : undefined;
}
