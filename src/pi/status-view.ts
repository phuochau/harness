function stable(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function renderStatus(snapshot: unknown): string {
  return `Harness status\n${stable(snapshot)}`;
}

export function renderGraph(graph: unknown): string {
  return `Harness graph\n${stable(graph)}`;
}

export function renderTask(snapshot: unknown, taskId: string): string {
  if (typeof snapshot !== "object" || snapshot === null) {
    return `Task ${taskId}\n${stable(snapshot)}`;
  }
  const jobs = (snapshot as { jobs?: unknown }).jobs;
  if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs)) {
    return `Task ${taskId}\n${stable(snapshot)}`;
  }
  const selected = Object.fromEntries(
    Object.entries(jobs).filter(([id]) => id.includes(taskId)),
  );
  return `Task ${taskId}\n${stable(selected)}`;
}

export function renderRunPreview(preview: unknown): string {
  return `Harness run approval\n${stable(preview)}`;
}
