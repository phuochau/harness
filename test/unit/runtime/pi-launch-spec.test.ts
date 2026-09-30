import { describe, expect, it } from "vitest";
import {
  buildPiLaunchSpec,
  type BuildPiLaunchSpecInput,
} from "../../../src/runtime/pi-worker/launch-spec.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";

function launchInput(overrides: Partial<BuildPiLaunchSpecInput> = {}): BuildPiLaunchSpecInput {
  return {
    attemptId: "attempt-1",
    attemptToken: "token-1",
    piExecutable: "/managed/bin/pi",
    profile: fixtureResolvedProfiles().byId["implementer-devin"]!,
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
    sessionDir: "/managed/sessions/T1",
    prompt: "Do the assignment",
    ...overrides,
  };
}

describe("Pi worker launch spec", () => {
  it("disables every ambient resource source and adds only managed resources", () => {
    const spec = buildPiLaunchSpec(launchInput({ sessionDir: "/managed/sessions/session-1" }));

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

  it("selects an explicit new session with --session-id and --session-dir", () => {
    const spec = buildPiLaunchSpec(launchInput());

    expect(spec.argv[spec.argv.indexOf("--session-id") + 1]).toBe("session-1");
    expect(spec.argv[spec.argv.indexOf("--session-dir") + 1]).toBe("/managed/sessions/T1");
    expect(spec.argv).not.toContain("--session");
    expect(spec.sessionId).toBe("session-1");
    expect(spec.sessionDir).toBe("/managed/sessions/T1");
  });

  it("selects a verified resume with --session and never --session-id", () => {
    const transcriptPath = "/managed/sessions/T1/2026-09-30T00-00-00-000Z_session-1.jsonl";
    const spec = buildPiLaunchSpec(launchInput({ resumeTranscriptPath: transcriptPath }));

    expect(spec.argv[spec.argv.indexOf("--session") + 1]).toBe(transcriptPath);
    expect(spec.argv).not.toContain("--session-id");
    expect(spec.argv).not.toContain("--session-dir");
    expect(spec.argv.at(-2)).toBe("--");
    expect(spec.argv.at(-1)).toBe("Do the assignment");
    expect(spec.sessionId).toBe("session-1");
    expect(spec.sessionDir).toBe("/managed/sessions/T1");
  });
});
