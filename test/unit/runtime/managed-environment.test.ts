import { describe, expect, it } from "vitest";
import { buildManagedEnvironment } from "../../../src/runtime/managed/environment.js";
import { managedRuntimePaths } from "../../../src/runtime/managed/paths.js";
import { redactDiagnostic } from "../../../src/runtime/managed/redaction.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";

const paths = managedRuntimePaths({
  dataHome: "/Users/example/Library/Application Support",
  runtimeVersion: "0.1.0",
  profileId: "implementer-devin",
});

describe("managed environment", () => {
  it("constructs a closed environment from an explicit allowlist", () => {
    const env = buildManagedEnvironment({
      profile: fixtureResolvedProfiles().byId["implementer-devin"]!,
      paths,
      ambient: {
        HOME: "/Users/example",
        XDG_CONFIG_HOME: "/Users/example/.config",
        ANTHROPIC_API_KEY: "must-not-leak",
        SAFE_PROXY: "allowed",
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
      },
      forwardedKeys: ["SAFE_PROXY"],
      executablePath: "/managed/bin:/usr/bin:/bin",
    });

    expect(env.HOME).toBe(paths.profileHome);
    expect(env.PI_CODING_AGENT_DIR).toBe(paths.piAgentDir);
    expect(env.XDG_CONFIG_HOME).toBe(paths.xdgConfigHome);
    expect(env.XDG_DATA_HOME).toBe(paths.xdgDataHome);
    expect(env.PATH).toBe("/managed/bin:/usr/bin:/bin");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SAFE_PROXY).toBe("allowed");
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("does not let forwarding override harness-owned roots", () => {
    expect(() =>
      buildManagedEnvironment({
        profile: fixtureResolvedProfiles().byId["implementer-devin"]!,
        paths,
        ambient: { HOME: "/attacker" },
        forwardedKeys: ["HOME"],
        executablePath: "/usr/bin:/bin",
      }),
    ).toThrow(/reserved environment key/);
  });

  it("redacts credentials, bearer tokens, URL userinfo, and named secrets", () => {
    expect(
      redactDiagnostic(
        "Bearer abc token=def https://user:pass@example.test API_COOKIE=ghi",
        ["API_COOKIE"],
      ),
    ).toBe(
      "Bearer [REDACTED] token=[REDACTED] https://[REDACTED]@example.test API_COOKIE=[REDACTED]",
    );
  });
});
