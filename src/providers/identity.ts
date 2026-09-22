export const integrationIds = ["pi-native", "codex-cli", "devin-cli", "claude-bridge"] as const;
export type PiIntegrationId = (typeof integrationIds)[number];

export interface ProfileIntegrationIdentity {
  readonly id: string;
  readonly integration?: string;
  readonly family: string;
  readonly provider: string;
  readonly extensions: readonly string[];
  readonly skills: readonly { readonly targets: readonly string[] }[];
}

export function effectiveIntegrationId(profile: {
  integration?: string;
  family: string;
  provider: string;
}): PiIntegrationId {
  if (profile.integration !== undefined) {
    if (!integrationIds.includes(profile.integration as PiIntegrationId)) {
      throw new Error(`unknown Pi integration ${profile.integration}`);
    }
    return profile.integration as PiIntegrationId;
  }
  if (profile.family === "codex" && profile.provider === "pi-shell-acp") return "codex-cli";
  if (profile.family === "devin" && profile.provider === "devin") return "devin-cli";
  if (profile.family === "claude" && profile.provider === "claude-bridge") return "claude-bridge";
  return "pi-native";
}

export function validateProfileIntegration(profile: ProfileIntegrationIdentity): PiIntegrationId {
  let integration: PiIntegrationId;
  try {
    integration = effectiveIntegrationId(profile);
  } catch (error) {
    throw new Error(`profile ${profile.id}: ${String(error instanceof Error ? error.message : error)}`);
  }
  const bridges: Readonly<Record<string, { provider: string; extension: string }>> = {
    "codex-cli": { provider: "pi-shell-acp", extension: "codex-acp" },
    "devin-cli": { provider: "devin", extension: "devin-acp" },
    "claude-bridge": { provider: "claude-bridge", extension: "claude-bridge" },
  };
  const bridge = bridges[integration];
  if (bridge) {
    if (profile.provider !== bridge.provider || !profile.extensions.includes(bridge.extension)) {
      throw new Error(`profile ${profile.id}: ${integration} requires provider ${bridge.provider} and extension ${bridge.extension}`);
    }
  } else if (Object.values(bridges).some(({ provider }) => provider === profile.provider)) {
    throw new Error(`profile ${profile.id}: pi-native cannot use bridge provider ${profile.provider}`);
  }
  if (integration !== "devin-cli" && integration !== "claude-bridge" &&
      profile.skills.some((skill) => skill.targets.includes("provider"))) {
    throw new Error(`profile ${profile.id}: provider skill projection is unsupported for ${profile.family} (${integration})`);
  }
  return integration;
}
