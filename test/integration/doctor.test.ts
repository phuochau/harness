import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import { executableCapabilities } from "../../src/cli/main.js";
import { readDeclarativeProject } from "../../src/cli/trusted-project-reader.js";
import { probeNodeVersion } from "../../src/install/probes.js";
import { maliciousProjectFixture } from "../support/install-fixtures.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("enforces the Node floor required by the Devin ACP dependency", () => {
  expect(probeNodeVersion("v22.19.0")).toEqual({
    id: "node",
    status: "wrong_version",
    version: "22.19.0",
    required: ">=22.22.2",
  });
  expect(probeNodeVersion("v22.22.2")).toEqual({
    id: "node",
    status: "present",
    version: "22.22.2",
    required: ">=22.22.2",
  });
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

it("does not require secondary execution-plane capabilities", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const capabilities = executableCapabilities(await readDeclarativeProject(root));
  expect(capabilities.map((item) => item.id)).not.toContain("secondary-runtime");
});

it("does not probe user-global agent plugins for managed profiles", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const capabilities = executableCapabilities(await readDeclarativeProject(root));
  const probes = Object.fromEntries(
    capabilities
      .filter((item) => item.id.startsWith("agent-plugin:superpowers-"))
      .map((item) => [item.id, item]),
  );

  expect(probes).toEqual({});
});

it("keeps global plugin discovery disabled when agent_plugins is absent", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const environmentPath = `${root}/.harness/environment.yaml`;
  const contents = await readFile(environmentPath, "utf8");
  await writeFile(
    environmentPath,
    contents.replace(/\nagent_plugins:\n(?:  .+\n|    .+\n)+$/, "\n"),
    "utf8",
  );
  const capabilities = executableCapabilities(await readDeclarativeProject(root));
  expect(capabilities.filter((item) => item.id.startsWith("agent-plugin:"))).toHaveLength(0);
});
