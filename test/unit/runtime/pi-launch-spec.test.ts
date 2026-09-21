import { describe, expect, it } from "vitest";
import { buildPiLaunchSpec } from "../../../src/runtime/pi-worker/launch-spec.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";

describe("Pi worker launch spec", () => {
  it("disables every ambient resource source and adds only managed resources", () => {
    const profile = fixtureResolvedProfiles().byId["implementer-devin"]!;
    const spec = buildPiLaunchSpec({
      attemptId: "attempt-1",
      attemptToken: "token-1",
      piExecutable: "/managed/bin/pi",
      profile,
      managed: {
        extensionPaths: ["/managed/devin/index.js"],
        piSkillPaths: ["/managed/superpowers/SKILL.md"],
        providerSkillPaths: ["/managed/provider/SKILL.md"],
        promptTemplatePaths: [],
        environment: { HOME: "/managed/home", PATH: "/managed/bin" },
        receiptHash: `sha256:${"a".repeat(64)}`,
      },
      transportExtensionPath: "/managed/harness/worker-transport.js",
      cwd: "/repo-worktree",
      sessionId: "session-1",
      sessionDir: "/managed/sessions/session-1",
      prompt: "Do the assignment",
    });

    expect(spec.executable).toBe("/managed/bin/pi");
    expect(spec.argv.slice(0, 10)).toEqual([
      "--mode", "json", "--print", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-context-files", "--no-themes",
      "--no-approve", "--provider",
    ]);
    expect(spec.argv).toContain("/managed/devin/index.js");
    expect(spec.argv).toContain("/managed/superpowers/SKILL.md");
    expect(spec.argv).toContain("/managed/harness/worker-transport.js");
    expect(spec.argv).not.toContain("/managed/provider/SKILL.md");
    expect(spec.argv.at(-2)).toBe("--");
    expect(spec.argv.at(-1)).toBe("Do the assignment");
    expect(spec.env.HOME).toBe("/managed/home");
  });
});
