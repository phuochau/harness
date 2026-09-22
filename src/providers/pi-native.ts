import { homedir } from "node:os";
import { join } from "node:path";
import { authStatus, noProjection, noVerification, retryWithoutProcess, type PiProviderAdapter } from "./types.js";

export const piNative: PiProviderAdapter = {
  id: "pi-native",
  authCommand(input) {
    return {
      executable: input.piExecutable,
      argv: ["--no-extensions", "--no-skills", "--no-prompt-templates",
        "--no-context-files", "--no-themes", "--no-approve",
        "--provider", input.profile.provider, "--model", input.profile.model, "--",
        "Run /login to authenticate this isolated harness profile, then /exit."],
      env: input.managedEnvironment,
    };
  },
  authProbe(input) {
    return {
      executable: input.piExecutable,
      argv: [...input.piExecutableArgs, ...input.probePrefix, "auth", "check", "--provider", input.profile.provider, "--json", "--no-refresh"],
      env: input.managedEnvironment,
      isAuthenticated: authStatus,
    };
  },
  credentialFiles(input) {
    const home = input.ambient.HOME ?? homedir();
    return [{ source: join(input.ambient.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "auth.json"),
      target: join(input.paths.piAgentDir, "auth.json") }];
  },
  providerSkillProjection: () => noProjection,
  environment: () => ({}),
  settings: () => [],
  verifyManaged: noVerification,
  recoverProviderSession: retryWithoutProcess,
};
