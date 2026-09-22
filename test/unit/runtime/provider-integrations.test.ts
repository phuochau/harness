import { expect, it } from "vitest";
import { providerIntegration } from "../../../src/providers/registry.js";
import { PiWorkerRuntime } from "../../../src/runtime/pi-worker/runtime.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";
import { managedRuntimePaths } from "../../../src/runtime/managed/paths.js";

const profiles = fixtureResolvedProfiles();
const managedEnvironment = { HOME: "/managed/home" };
const input = { managedEnvironment, piExecutable: "pi", piExecutableArgs: [] };

it("selects adapters by effective integration without conflating direct Pi with Codex ACP", () => {
  const directPi = profiles.byId["planner-codex"]!;
  const codex = { ...profiles.byId["implementer-codex"]!, provider: "pi-shell-acp" };
  const devin = profiles.byId["implementer-devin"]!;
  const claude = profiles.byId["implementer-claude"]!;
  expect([directPi, codex, devin, claude].map((profile) => providerIntegration(profile).id))
    .toEqual(["pi-native", "codex-cli", "devin-cli", "claude-bridge"]);
  expect(providerIntegration(directPi).authCommand({ ...input, profile: directPi }).argv)
    .toContain("Run /login to authenticate this isolated harness profile, then /exit.");
  expect(providerIntegration(codex).authCommand({ ...input, profile: codex })).toMatchObject({ executable: "codex", argv: ["login"] });
  expect(providerIntegration(devin).authCommand({ ...input, profile: devin })).toMatchObject({ executable: "devin", argv: ["auth", "login"] });
  expect(providerIntegration(claude).authCommand({ ...input, profile: claude })).toMatchObject({ executable: "claude", argv: ["auth", "login", "--claudeai"] });
  expect(providerIntegration(directPi).authProbe({ ...input, profile: directPi }).argv)
    .toEqual(["auth", "check", "--provider", directPi.provider, "--json", "--no-refresh"]);
  expect(providerIntegration(directPi).authProbe({ ...input, profile: directPi,
    piExecutableArgs: ["/managed/pi-cli.js"] }).argv)
    .toEqual(["/managed/pi-cli.js", "auth", "check", "--provider", directPi.provider, "--json", "--no-refresh"]);
  expect(providerIntegration(directPi).authCommand({ ...input, profile: directPi,
    managedExtensionPaths: ["/managed/native-provider.js"] }).argv)
    .toContain("/managed/native-provider.js");
  const extensionProbe = providerIntegration(directPi).authProbe({ ...input, profile: directPi,
    piExecutableArgs: ["/managed/pi-cli.js"], managedExtensionPaths: ["/managed/native-provider.js"] });
  expect(extensionProbe.argv).toContain("/managed/native-provider.js");
  expect(extensionProbe.argv).not.toContain("auth");
  expect(providerIntegration(codex).authProbe({ ...input, profile: codex }).argv).toEqual(["login", "status"]);
  expect(providerIntegration(devin).authProbe({ ...input, profile: devin }).argv).toEqual(["auth", "status"]);
  expect(providerIntegration(claude).authProbe({ ...input, profile: claude }).argv).toEqual(["auth", "status"]);
  expect(providerIntegration(codex).authProbe({ ...input, profile: codex })
    .isAuthenticated("Not logged in", "", 0)).toBe(false);
  expect(providerIntegration(devin).authProbe({ ...input, profile: devin })
    .isAuthenticated("Logged in (via Devin)", "", 0)).toBe(true);
  expect(() => providerIntegration({ ...directPi, integration: "unknown-cli" }))
    .toThrow(/unknown-cli/);
});

it("does not guess process-less Pi session recovery from provider identity", async () => {
  const profile = profiles.byId["planner-codex"]!;
  const runtime = new PiWorkerRuntime({
    profiles, managedProfiles: {}, supervisor: {} as never,
    piExecutable: "pi", transportExtensionPath: "/transport.js",
  });
  const decision = await runtime.recover({ attemptId: "a", profile, launch: { sessionId: "pi-session" } } as never, {
    attemptId: "a", providerSession: { source: "pi", id: "session-1" },
  });
  expect(decision.status).toBe("retry");
});

it("declares provider skill and settings projections through adapters", () => {
  const paths = managedRuntimePaths({ dataHome: "/tmp/managed", runtimeVersion: "0.1.0", profileId: "implementer-devin" });
  const skill = { paths, name: "selected", id: "superpowers:test-driven-development", content: "# Selected skill" };
  expect(providerIntegration(profiles.byId["implementer-devin"]!).providerSkillProjection(skill))
    .toEqual({ kind: "copy-home", directory: `${paths.profileHome}/.agents/skills/selected` });
  expect(providerIntegration(profiles.byId["implementer-claude"]!).providerSkillProjection(skill))
    .toEqual({ kind: "inline", id: skill.id, content: skill.content });
  expect(providerIntegration(profiles.byId["planner-codex"]!).providerSkillProjection(skill))
    .toEqual({ kind: "none" });
  expect(providerIntegration(profiles.byId["implementer-claude"]!).settings({ paths, forwardedSkills: [] }))
    .toEqual([expect.objectContaining({ path: `${paths.piAgentDir}/claude-bridge.json` })]);
  expect(providerIntegration({ ...profiles.byId["implementer-codex"]!, provider: "pi-shell-acp" })
    .settings({ paths, forwardedSkills: [] }))
    .toEqual([expect.objectContaining({ path: `${paths.profileHome}/.pi/agent/settings.json` })]);
});
