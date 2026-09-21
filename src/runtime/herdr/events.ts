import type { HerdrEvent } from "./client.js";

export interface AgentLifecycleObservation {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly status: "idle" | "working" | "blocked" | "done" | "unknown";
  readonly revision: number;
  readonly completionDecided: false;
}

const statuses = new Set(["idle", "working", "blocked", "done", "unknown"]);

export class HerdrEventTracker {
  private readonly observations = new Map<string, AgentLifecycleObservation>();
  private sequence = 0;

  public observe(event: HerdrEvent): void {
    if (event.event !== "pane.agent_status_changed") return;
    const paneId = event.data.pane_id;
    const workspaceId = event.data.workspace_id;
    const status = event.data.agent_status;
    const suppliedRevision = event.data.revision;
    if (
      typeof paneId !== "string" ||
      typeof workspaceId !== "string" ||
      typeof status !== "string" ||
      !statuses.has(status) ||
      (suppliedRevision !== undefined &&
        (typeof suppliedRevision !== "number" ||
          !Number.isSafeInteger(suppliedRevision) ||
          suppliedRevision < 0))
    ) {
      return;
    }
    const prior = this.observations.get(paneId);
    const revision = suppliedRevision === undefined
      ? Math.max(this.sequence, prior?.revision ?? 0) + 1
      : suppliedRevision as number;
    this.sequence = Math.max(this.sequence, revision);
    if (prior !== undefined && prior.revision >= revision) return;
    this.observations.set(paneId, {
      paneId,
      workspaceId,
      status: status as AgentLifecycleObservation["status"],
      revision,
      completionDecided: false,
    });
  }

  public latest(paneId: string): AgentLifecycleObservation | undefined {
    return this.observations.get(paneId);
  }
}
