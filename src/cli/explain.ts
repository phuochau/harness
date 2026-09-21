import type { HarnessEvent } from "../contracts/events.js";
import { loadRun, type RunOperationOptions } from "./status.js";

export interface ExplainOptions extends RunOperationOptions {
  readonly target: string;
}

export async function explain(options: ExplainOptions): Promise<readonly HarnessEvent[]> {
  const { events } = await loadRun(options);
  return events.filter((event) =>
    event.entityId === options.target ||
    event.idempotencyKey === options.target ||
    (event.eventType === "effect.intent" && event.payload.idempotencyKey === options.target),
  );
}
