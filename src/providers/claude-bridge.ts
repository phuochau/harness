import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { authStatus, retryWithoutProcess, type PiProviderAdapter } from "./types.js";

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
  providerSkillProjection(input) {
    return { kind: "inline", id: input.id, content: input.content };
  },
  environment: () => ({}),
  settings(input) {
    return [{ path: join(input.paths.piAgentDir, "claude-bridge.json"), content: `${JSON.stringify({
      strictMcpConfig: true,
      askClaude: { enabled: false },
      autoMemoryEnabled: false,
      mcpServers: {},
      forwardedSkills: input.forwardedSkills,
    }, null, 2)}\n` }];
  },
  async verifyManaged(input) {
    try {
      const agentDirectory = input.managed.environment.PI_CODING_AGENT_DIR;
      if (agentDirectory === undefined) throw new Error("missing Pi agent directory");
      const configuration = JSON.parse(await readFile(join(agentDirectory, "claude-bridge.json"), "utf8")) as Record<string, unknown>;
      const askClaude = configuration.askClaude as Record<string, unknown> | undefined;
      if (configuration.strictMcpConfig !== true || configuration.autoMemoryEnabled !== false || askClaude?.enabled !== false) {
        throw new Error("unsafe Claude bridge settings");
      }
      return { verified: true, evidence: [] };
    } catch {
      return { verified: false, evidence: ["Claude bridge strict configuration is missing or unsafe"] };
    }
  },
  recoverProviderSession: retryWithoutProcess,
};
