import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authStatus, noProjection, noVerification, retryWithoutProcess, type PiProviderAdapter } from "./types.js";

export const piNative: PiProviderAdapter = {
  id: "pi-native",
  authCommand(input) {
    return {
      executable: input.piExecutable,
      argv: ["--no-extensions", "--no-skills", "--no-prompt-templates",
        "--no-context-files", "--no-themes", "--no-approve",
        ...(input.managedExtensionPaths ?? []).flatMap((path) => ["--extension", path]),
        "--provider", input.profile.provider, "--model", input.profile.model, "--",
        "Run /login to authenticate this isolated harness profile, then /exit."],
      env: input.managedEnvironment,
    };
  },
  authProbe(input) {
    if ((input.managedExtensionPaths?.length ?? 0) > 0) {
      const cli = input.piExecutableArgs[0];
      if (cli === undefined) throw new Error("pi-native extension auth probe requires the managed Pi CLI path");
      return {
        executable: input.piExecutable,
        argv: [fileURLToPath(new URL("./pi-native-auth-probe.js", import.meta.url)),
          cli, input.profile.provider, input.profile.model, ...input.managedExtensionPaths!],
        env: input.managedEnvironment,
        isAuthenticated: authStatus,
      };
    }
    return {
      executable: input.piExecutable,
      argv: [...input.piExecutableArgs, "auth", "check", "--provider", input.profile.provider, "--json", "--no-refresh"],
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
