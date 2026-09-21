export function runBranchName(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`invalid run ID: ${runId}`);
  }
  return `harness/run-${runId}`;
}

export function planningBranchName(runId: string): string {
  runBranchName(runId);
  return `harness/plan-${runId}`;
}

export function taskBranchName(runId: string, taskId: string): string {
  runBranchName(runId);
  if (!/^T[0-9]{3,}$/.test(taskId)) throw new Error(`invalid task ID: ${taskId}`);
  return `harness/${runId}-${taskId}`;
}
