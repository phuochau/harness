import { homedir } from "node:os";
import { join } from "node:path";
import { authStatus, noProjection, noVerification, type PiProviderAdapter } from "./types.js";

export function recoverInterruptedDevin(input: {
  readonly piSessionId: string;
  readonly priorProviderSessionId: string;
  readonly loadedProviderSessionId: string;
}): { status: "retry"; reason: string } | { status: "resume"; sessionId: string } {
  if (input.priorProviderSessionId !== input.loadedProviderSessionId) {
    return { status: "retry", reason: "provider session identity changed" };
  }
  return { status: "resume", sessionId: input.piSessionId };
}

export const devinCli: PiProviderAdapter = {
  id: "devin-cli",
  authCommand(input) {
    return { executable: input.devinExecutable ?? "devin", argv: ["auth", "login"], env: input.managedEnvironment };
  },
  authProbe(input) {
    return { executable: input.devinExecutable ?? "devin", argv: ["auth", "status"],
      env: input.managedEnvironment, isAuthenticated: authStatus };
  },
  credentialFiles(input) {
    const home = input.ambient.HOME ?? homedir();
    return [
      { source: join(input.ambient.XDG_DATA_HOME ?? join(home, ".local", "share"), "devin", "credentials.toml"),
        target: join(input.paths.xdgDataHome, "devin", "credentials.toml") },
      { source: join(input.ambient.XDG_CONFIG_HOME ?? join(home, ".config"), "devin", "config.json"),
        target: join(input.paths.xdgConfigHome, "devin", "config.json") },
    ];
  },
  providerSkillProjection: () => noProjection,
  environment: () => ({}),
  settings: () => [],
  verifyManaged: noVerification,
  recoverProviderSession: () => ({ status: "retry", reason: "Devin provider session cannot be proven resumable" }),
};
