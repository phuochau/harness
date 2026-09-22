import { homedir } from "node:os";
import { join } from "node:path";
import { authStatus, noProjection, noVerification, retryWithoutProcess, type PiProviderAdapter } from "./types.js";

export const codexCli: PiProviderAdapter = {
  id: "codex-cli",
  authCommand(input) {
    return { executable: input.codexExecutable ?? "codex", argv: ["login"], env: input.managedEnvironment };
  },
  authProbe(input) {
    return { executable: input.codexExecutable ?? "codex", argv: ["login", "status"],
      env: input.managedEnvironment, isAuthenticated: authStatus };
  },
  credentialFiles(input) {
    const home = input.ambient.HOME ?? homedir();
    return [{ source: join(input.ambient.CODEX_HOME ?? join(home, ".codex"), "auth.json"),
      target: join(input.paths.profileHome, ".codex", "auth.json") }];
  },
  providerSkillProjection: () => noProjection,
  environment: () => ({}),
  settings: () => [],
  verifyManaged: noVerification,
  recoverProviderSession: retryWithoutProcess,
};
