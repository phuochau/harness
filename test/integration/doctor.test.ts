import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
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
