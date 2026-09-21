import { deepFreeze } from "../shared/deep-freeze.js";
import type { PlanningProfileLifecycle } from "./planning-agent.js";

export interface ModelIdentity {
  readonly provider: string;
  readonly modelId: string;
}

export interface PlanningProfileLease {
  readonly correlationId: string;
  readonly previous: { readonly model: ModelIdentity; readonly thinkingLevel: string };
  readonly planning: { readonly model: ModelIdentity; readonly thinkingLevel: string };
  readonly entryId: string;
}

export interface TerminalPlanningSettlement {
  readonly correlationId: string;
  readonly terminal: true;
  readonly finalTurnIndex: number;
}

export interface PiModelPort {
  currentModel(): Promise<ModelIdentity>;
  currentThinkingLevel(): Promise<string>;
  resolveAuthenticatedProfile(
    name: string,
  ): Promise<{ readonly model: ModelIdentity; readonly thinkingLevel: string } | undefined>;
  resolveModelIdentity(identity: ModelIdentity): Promise<ModelIdentity | undefined>;
  selectModel(model: ModelIdentity): Promise<void>;
  selectThinkingLevel(level: string): Promise<void>;
  appendEntry(customType: string, data: unknown): void;
  getLeafId(): string | undefined;
}

export interface PlanningProfileStore {
  activeLease(): Promise<PlanningProfileLease | undefined>;
  isRestored(selectedEntryId: string): Promise<boolean>;
  driftReason(correlationId: string): Promise<string | undefined>;
}

export class PlanningProfilePolicyError extends Error {}

function sameModel(left: ModelIdentity, right: ModelIdentity): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

export class PlanningProfileCoordinator implements PlanningProfileLifecycle {
  private transitioning = false;

  public constructor(
    private readonly pi: PiModelPort,
    private readonly store: PlanningProfileStore,
  ) {}

  public async begin(correlationId: string): Promise<PlanningProfileLease> {
    if (await this.store.activeLease()) {
      throw new PlanningProfilePolicyError("PLANNING_PROFILE_ALREADY_LEASED");
    }
    const previous = {
      model: await this.pi.currentModel(),
      thinkingLevel: await this.pi.currentThinkingLevel(),
    };
    const planning = await this.pi.resolveAuthenticatedProfile("chatgpt-planning");
    if (planning?.model.provider !== "openai-codex") {
      throw new PlanningProfilePolicyError("CHATGPT_PLANNING_PROFILE_UNAVAILABLE");
    }
    this.pi.appendEntry("harness:planning-profile-selected", {
      correlationId,
      previous,
      planning,
    });
    const entryId = this.pi.getLeafId();
    if (!entryId) {
      throw new PlanningProfilePolicyError("planning profile entry was not persisted");
    }
    const lease = deepFreeze({ correlationId, previous, planning, entryId });
    this.transitioning = true;
    try {
      await this.pi.selectModel(planning.model);
      await this.pi.selectThinkingLevel(planning.thinkingLevel);
    } finally {
      this.transitioning = false;
    }
    return lease;
  }

  public async observeIdentity(model: ModelIdentity, thinkingLevel: string): Promise<void> {
    if (this.transitioning) return;
    const lease = await this.store.activeLease();
    if (
      lease === undefined ||
      (sameModel(model, lease.planning.model) && thinkingLevel === lease.planning.thinkingLevel) ||
      (await this.store.driftReason(lease.correlationId)) !== undefined
    ) {
      return;
    }
    this.pi.appendEntry("harness:planning-profile-drift", {
      correlationId: lease.correlationId,
      selectedEntryId: lease.entryId,
      reason: "planning model drift detected before settlement",
      observed: { model, thinkingLevel },
    });
  }

  public async restoreAfterSettlement(
    lease: PlanningProfileLease,
    settlement: TerminalPlanningSettlement,
  ): Promise<void> {
    if (settlement.correlationId !== lease.correlationId || !settlement.terminal) {
      throw new PlanningProfilePolicyError(
        "profile restore requires the exact terminal planning settlement",
      );
    }
    if (await this.store.isRestored(lease.entryId)) return;
    const previousModel = await this.pi.resolveModelIdentity(lease.previous.model);
    if (!previousModel) {
      throw new PlanningProfilePolicyError("PREVIOUS_INTERACTIVE_MODEL_UNAVAILABLE");
    }
    this.transitioning = true;
    try {
      await this.pi.selectModel(previousModel);
      await this.pi.selectThinkingLevel(lease.previous.thinkingLevel);
    } finally {
      this.transitioning = false;
    }
    this.pi.appendEntry("harness:planning-profile-restored", {
      correlationId: lease.correlationId,
      selectedEntryId: lease.entryId,
      finalTurnIndex: settlement.finalTurnIndex,
    });
  }

  public async settle(
    correlationId: string,
    finalTurnIndex: number,
  ): Promise<string | undefined> {
    const lease = await this.store.activeLease();
    if (lease?.correlationId !== correlationId) {
      throw new PlanningProfilePolicyError("missing correlation-bound planning profile lease");
    }
    await this.observeIdentity(
      await this.pi.currentModel(),
      await this.pi.currentThinkingLevel(),
    );
    const drift = await this.store.driftReason(correlationId);
    await this.restoreAfterSettlement(lease, {
      correlationId,
      terminal: true,
      finalTurnIndex,
    });
    return drift;
  }

  public async abortBeforeDispatch(
    correlationId: string,
    reason: string,
  ): Promise<void> {
    const lease = await this.store.activeLease();
    if (lease?.correlationId !== correlationId) return;
    if (!(await this.store.isRestored(lease.entryId))) {
      const previousModel = await this.pi.resolveModelIdentity(lease.previous.model);
      if (!previousModel) {
        throw new PlanningProfilePolicyError("PREVIOUS_INTERACTIVE_MODEL_UNAVAILABLE");
      }
      this.transitioning = true;
      try {
        await this.pi.selectModel(previousModel);
        await this.pi.selectThinkingLevel(lease.previous.thinkingLevel);
      } finally {
        this.transitioning = false;
      }
      this.pi.appendEntry("harness:planning-profile-restored", {
        correlationId,
        selectedEntryId: lease.entryId,
        reason: "dispatch_failed_before_correlated_user_entry",
      });
    }
    this.pi.appendEntry("harness:planning-generation-invalidated", {
      correlationId,
      selectedEntryId: lease.entryId,
      reason,
    });
  }
}
