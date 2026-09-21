import { expect, it } from "vitest";
import type { ResolvedProfile } from "../../src/config/profiles.js";
import { authCommand } from "../../src/cli/auth.js";
import { sha256 } from "../../src/shared/sha256.js";

function profile(family: "codex" | "devin" | "claude"): ResolvedProfile {
  return {
    id: `planner-${family}`,
    family,
    runtime: "pi",
    provider: family === "codex" ? "pi-shell-acp" : family === "devin" ? "devin" : "claude-bridge",
    model: `${family}/model`,
    role: "planning",
    environment: "isolated",
    tools: [], extensions: [], skills: [], promptTemplates: [], contextFiles: false, mcp: [],
    hash: sha256(family),
  };
}

it("builds subscription-only auth commands inside the managed profile home", () => {
  const environment = { HOME: "/managed/home", PATH: "/bin" };
  const codex = authCommand({ profile: profile("codex"), managedEnvironment: environment, piExecutable: "/managed/pi" });
  expect(codex).toMatchObject({ executable: "codex", env: environment, argv: ["login"] });
  expect(codex.argv.join(" ")).not.toMatch(/api[-_ ]?key/i);
  expect(authCommand({ profile: profile("devin"), managedEnvironment: environment, piExecutable: "pi" })).toMatchObject({ executable: "devin", argv: ["auth", "login"] });
  expect(authCommand({ profile: profile("claude"), managedEnvironment: environment, piExecutable: "pi" })).toMatchObject({ executable: "claude", argv: ["auth", "login", "--claudeai"] });
});
