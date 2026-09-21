import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ModelIdentity,
  PiModelPort,
  PlanningProfileLease,
  PlanningProfileStore,
} from "./planning-profile.js";

function record(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function customEntries(context: ExtensionContext, type: string) {
  return context.sessionManager.getBranch().flatMap((entry) =>
    entry.type === "custom" && entry.customType === type
      ? [{ id: entry.id, data: entry.data }]
      : [],
  );
}

export class PiSessionPlanningProfileStore implements PlanningProfileStore {
  public constructor(private readonly context: ExtensionContext) {}

  public async activeLease(): Promise<PlanningProfileLease | undefined> {
    const restored = new Set(customEntries(this.context, "harness:planning-profile-restored")
      .map((entry) => record(entry.data)?.selectedEntryId)
      .filter((id): id is string => typeof id === "string"));
    const invalidated = new Set(customEntries(this.context, "harness:planning-generation-invalidated")
      .map((entry) => record(entry.data)?.selectedEntryId)
      .filter((id): id is string => typeof id === "string"));
    for (const entry of [...customEntries(this.context, "harness:planning-profile-selected")].reverse()) {
      if (restored.has(entry.id) || invalidated.has(entry.id)) continue;
      const data = record(entry.data);
      if (
        typeof data?.correlationId === "string" &&
        record(data.previous) !== undefined &&
        record(data.planning) !== undefined
      ) return { ...data, entryId: entry.id } as PlanningProfileLease;
    }
    return undefined;
  }

  public async isRestored(selectedEntryId: string): Promise<boolean> {
    return customEntries(this.context, "harness:planning-profile-restored")
      .some((entry) => record(entry.data)?.selectedEntryId === selectedEntryId);
  }

  public async driftReason(correlationId: string): Promise<string | undefined> {
    const entry = [...customEntries(this.context, "harness:planning-profile-drift")]
      .reverse()
      .find((candidate) => record(candidate.data)?.correlationId === correlationId);
    const reason = record(entry?.data)?.reason;
    return typeof reason === "string" ? reason : undefined;
  }
}

export class PiSessionModelPort implements PiModelPort {
  public constructor(
    private readonly pi: ExtensionAPI,
    private readonly context: ExtensionContext,
  ) {}

  public async currentModel(): Promise<ModelIdentity> {
    const model = this.context.model;
    if (model === undefined) throw new Error("Pi has no selected model");
    return { provider: model.provider, modelId: model.id };
  }

  public async currentThinkingLevel(): Promise<string> {
    return this.context.thinkingLevel ?? this.pi.getThinkingLevel();
  }

  public async resolveAuthenticatedProfile(name: string) {
    if (name !== "chatgpt-planning") return undefined;
    const scoped = this.context.scopedModels.length > 0
      ? this.context.scopedModels.map((entry) => entry.model)
      : this.context.modelRegistry.getAvailable();
    const model = [this.context.model, ...scoped].find(
      (candidate) => candidate?.provider === "openai-codex" &&
        this.context.modelRegistry.hasConfiguredAuth(candidate),
    );
    if (model === undefined) return undefined;
    return {
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: "high",
    };
  }

  public async resolveModelIdentity(identity: ModelIdentity): Promise<ModelIdentity | undefined> {
    const model = this.context.modelRegistry.find(identity.provider, identity.modelId);
    return model === undefined ? undefined : identity;
  }

  public async selectModel(identity: ModelIdentity): Promise<void> {
    const model = this.context.modelRegistry.find(identity.provider, identity.modelId);
    if (model === undefined || !(await this.pi.setModel(model))) {
      throw new Error(`Pi model is unavailable: ${identity.provider}/${identity.modelId}`);
    }
  }

  public async selectThinkingLevel(level: string): Promise<void> {
    this.pi.setThinkingLevel(level as any);
  }

  public appendEntry(customType: string, data: unknown): void {
    this.pi.appendEntry(customType, data);
  }

  public getLeafId(): string | undefined {
    return this.context.sessionManager.getLeafId() ?? undefined;
  }
}
