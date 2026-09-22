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
  settings(input) {
    return [{ path: join(input.paths.piAgentDir, "settings.json"), content: `${JSON.stringify({
      compaction: { enabled: false },
      piShellAcpProvider: {
        backend: "codex",
        appendSystemPrompt: false,
        settingSources: [],
        strictMcpConfig: true,
        showToolNotifications: false,
        tools: ["Read", "Bash", "Edit", "Write"],
        skillPlugins: [],
        permissionAllow: ["Read(*)", "Bash(*)", "Edit(*)", "Write(*)"],
        mcpServers: {},
        codexDisabledFeatures: ["image_generation", "tool_suggest", "tool_search",
          "multi_agent", "apps", "memories"],
      },
    }, null, 2)}\n` }];
  },
  verifyManaged: noVerification,
  recoverProviderSession: retryWithoutProcess,
};
