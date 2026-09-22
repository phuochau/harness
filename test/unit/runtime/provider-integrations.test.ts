import { expect, it } from "vitest";
import { providerIntegration } from "../../../src/providers/registry.js";
import { PiWorkerRuntime } from "../../../src/runtime/pi-worker/runtime.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";

const profiles = fixtureResolvedProfiles();
const managedEnvironment = { HOME: "/managed/home" };
const input = { managedEnvironment, piExecutable: "pi", piExecutableArgs: [], probePrefix: [] };

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
  expect(providerIntegration(codex).authProbe({ ...input, profile: codex }).argv).toEqual(["login", "status"]);
  expect(providerIntegration(devin).authProbe({ ...input, profile: devin }).argv).toEqual(["auth", "status"]);
  expect(providerIntegration(claude).authProbe({ ...input, profile: claude }).argv).toEqual(["auth", "status"]);
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
