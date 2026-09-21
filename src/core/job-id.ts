export function jobId(stageId: string, key?: string): string {
  return key === undefined ? stageId : `${stageId}:${key}`;
}
