import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import { executableCapabilities } from "../../src/cli/main.js";
import { readDeclarativeProject } from "../../src/cli/trusted-project-reader.js";
import { maliciousProjectFixture } from "../support/install-fixtures.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("returns a schema-versioned report with required versions and redacted evidence", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const report = await doctor(
    { root },
    {
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      probe: async () => ({
        byId: {
          "pi-multi-agent-harness": {
            id: "pi-multi-agent-harness",
            status: "missing",
            evidence: ["Authorization: Bearer top-secret token=abc"],
          },
          "auth:github-cli": { id: "auth:github-cli", status: "missing_auth" },
        },
      }),
    },
  );
  expect(report).toMatchObject({
    schemaVersion: 1,
    ok: false,
    checkedAt: "2026-09-21T00:00:00.000Z",
  });
  expect(report.capabilities.find((item) => item.id === "pi-multi-agent-harness"))
    .toMatchObject({ requiredVersion: "0.1.0", status: "missing" });
  expect(JSON.stringify(report)).not.toContain("top-secret");
  expect(JSON.stringify(report)).not.toContain("token=abc");
  expect(report.capabilities.find((item) => item.id === "pi-multi-agent-harness")?.repair)
    .toMatch(/bootstrap/);
});

it("treats every missing required locked capability as unhealthy", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const report = await doctor({ root }, { probe: async () => ({ byId: {} }) });
  expect(report.ok).toBe(false);
  expect(report.capabilities.some((item) => item.id === "devin" && item.status === "missing"))
    .toBe(true);
});

it("requires current Herdr integrations for Pi and every routed worker", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const capabilities = executableCapabilities(await readDeclarativeProject(root));
  const integrations = capabilities.filter((item) =>
    item.id.startsWith("herdr-integration:"),
  );
  expect(integrations.map((item) => item.id).sort()).toEqual([
    "herdr-integration:claude",
    "herdr-integration:codex",
    "herdr-integration:devin",
    "herdr-integration:pi",
  ]);
  for (const integration of integrations) {
    const target = integration.id.slice("herdr-integration:".length);
    expect(integration.parseVersion(`${target}: current (v1) (/tmp/hook)`)).toBe("current");
    expect(integration.parseVersion(`${target}: not installed (/tmp/hook)`)).toBeUndefined();
  }
});

it("requires the locked Superpowers version in Pi and every supported worker", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const capabilities = executableCapabilities(await readDeclarativeProject(root));
  const probes = Object.fromEntries(
    capabilities
      .filter((item) => item.id.startsWith("superpowers:"))
      .map((item) => [item.id, item]),
  );

  expect(Object.keys(probes).sort()).toEqual([
    "superpowers:claude",
    "superpowers:codex",
    "superpowers:devin",
    "superpowers:pi",
  ]);
  expect(probes["superpowers:pi"]?.parseVersion(
    "  /opt/pi-harness/superpowers/6.4.1\n",
  )).toBe("6.4.1");
  expect(probes["superpowers:pi"]?.parseVersion(
    "  C:\\pi-harness\\superpowers\\6.4.1\n",
  )).toBe("6.4.1");
  expect(probes["superpowers:pi"]?.parseVersion(
    "  /opt/pi-harness/superpowers/6.4.10\n",
  )).toBeUndefined();
  expect(probes["superpowers:devin"]?.parseVersion(
    "superpowers v6.4.1 enabled\n",
  )).toBe("6.4.1");
  expect(probes["superpowers:devin"]?.parseVersion(
    "superpowers v6.4.10 enabled\n",
  )).toBeUndefined();
  expect(probes["superpowers:claude"]?.parseVersion(JSON.stringify([
    { id: "superpowers@superpowers-dev", version: "6.4.1", enabled: true },
  ]))).toBe("6.4.1");
  expect(probes["superpowers:claude"]?.parseVersion(JSON.stringify([
    { id: "superpowers@superpowers-dev", version: "6.4.1", enabled: false },
  ]))).toBeUndefined();
});
