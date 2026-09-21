import type { WorkerResult } from "../../contracts/worker-result.js";

export type ParsedWorkerResult =
  | { readonly status: "valid"; readonly result: WorkerResult }
  | { readonly status: "invalid"; readonly reason: string };
