import type { WorkerKind } from "../../core/routing.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { DevinAdapter } from "./devin.js";
import type { WorkerAdapter } from "./types.js";

export function workerAdapters(): ReadonlyMap<WorkerKind, WorkerAdapter> {
  return new Map<WorkerKind, WorkerAdapter>([
    ["codex", new CodexAdapter()],
    ["devin", new DevinAdapter()],
    ["claude", new ClaudeAdapter()],
  ]);
}

export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { DevinAdapter } from "./devin.js";
export type * from "./types.js";
