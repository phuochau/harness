import { describe, expect, it } from "vitest";
import { buildPiLaunchSpec } from "../../../src/runtime/pi-worker/launch-spec.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";

describe("managed Pi profile startup contexts", () => {
  for (const family of ["codex", "devin", "claude"] as const) {
    it(`keeps ${family} free of ambient resources`, () => {
      const profile = fixtureResolvedProfiles().byId[`implementer-${family}`]!;
      const managedSkills = profile.skills
        .filter((skill) => skill.targets.includes("pi"))
        .map((skill) => skill.path);
      const spec = buildPiLaunchSpec({
        attemptId: `attempt-${family}`,
        attemptToken: "token",
        piExecutable: "/managed/bin/pi",
        profile,
        managed: {
          extensionPaths: profile.extensions,
          piSkillPaths: managedSkills,
          providerSkillPaths: profile.skills
            .filter((skill) => skill.targets.includes("provider"))
            .map((skill) => skill.path),
          promptTemplatePaths: profile.promptTemplates,
          environment: {
            HOME: `/managed/${family}/home`,
            PI_CODING_AGENT_DIR: `/managed/${family}/pi-agent`,
            PATH: "/managed/bin",
          },
          receiptHash: `sha256:${"a".repeat(64)}`,
        },
        transportExtensionPath: "/managed/harness/worker-transport.js",
        cwd: "/repo",
        sessionId: "session",
        sessionDir: "/managed/session",
        prompt: "assignment",
      });
      const captured = JSON.stringify(spec);
      expect(captured).not.toContain("forbidden-global-skill");
      expect(spec.argv).toContain("--no-skills");
      expect(spec.argv).toContain("--no-extensions");
      for (const skill of managedSkills) expect(spec.argv).toContain(skill);
    });
  }
});
