import { homedir } from "node:os";
import { join } from "node:path";
import { authStatus, noProjection, noVerification, retryWithoutProcess, type PiProviderAdapter } from "./types.js";

export const claudeBridge: PiProviderAdapter = {
  id: "claude-bridge",
  authCommand(input) {
    return { executable: input.claudeExecutable ?? "claude", argv: ["auth", "login", "--claudeai"], env: input.managedEnvironment };
  },
  authProbe(input) {
    return { executable: input.claudeExecutable ?? "claude", argv: ["auth", "status"],
      env: input.managedEnvironment, isAuthenticated: authStatus };
  },
  credentialFiles(input) {
    const home = input.ambient.HOME ?? homedir();
    return [
      { source: join(home, ".claude.json"), target: join(input.paths.profileHome, ".claude.json") },
      { source: join(home, ".claude", ".credentials.json"), target: join(input.paths.profileHome, ".claude", ".credentials.json") },
    ];
  },
  providerSkillProjection: () => noProjection,
  environment: () => ({}),
  settings: () => [],
  verifyManaged: noVerification,
  recoverProviderSession: retryWithoutProcess,
};
