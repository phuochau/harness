import type { ResolvedProfile } from "../config/profiles.js";
import { effectiveIntegrationId, type PiIntegrationId } from "./identity.js";
import { piNative } from "./pi-native.js";
import { codexCli } from "./codex-cli.js";
import { devinCli } from "./devin-cli.js";
import { claudeBridge } from "./claude-bridge.js";
import type { PiProviderAdapter } from "./types.js";

export const integrations: Readonly<Record<PiIntegrationId, PiProviderAdapter>> = Object.freeze({
  "pi-native": piNative,
  "codex-cli": codexCli,
  "devin-cli": devinCli,
  "claude-bridge": claudeBridge,
});

export function providerIntegration(profile: ResolvedProfile): PiProviderAdapter {
  return integrations[effectiveIntegrationId(profile)];
}
