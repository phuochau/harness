import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bootstrap } from "../../src/cli/bootstrap.js";
import { builtInBaseline } from "../../src/install/baseline-policy.js";
import { ReceiptStore } from "../../src/install/receipts.js";
import { maliciousProjectFixture, exists } from "../support/install-fixtures.js";
import { FakeProcessRunner } from "../support/fake-process.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("does not execute repository content before approval", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const process = new FakeProcessRunner();
  const result = await bootstrap(
    { root, dryRun: true },
    {
      baseline: builtInBaseline(),
      probe: async () => ({ byId: {} }),
      presenter: { show: async () => undefined },
      approvals: { requirePlanHash: async () => ({ approved: false, planHash: "" }) },
      executor: {
        process,
        receipts: new ReceiptStore(join(root, ".harness/receipts.jsonl")),
        verifySource: async () => true,
      },
    },
  );
  expect(result.status).toBe("planned");
  expect(process.calls).toHaveLength(0);
  for (const marker of ["owned", "owned2", "owned3", "pi-loaded"]) {
    expect(await exists(join(root, marker))).toBe(false);
  }
});

it("installs the approved project-local Pi package and verifies it", async () => {
  const root = await maliciousProjectFixture();
  temporary.push(root);
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "installed", stderr: "" });
  let installed = false;
  const versions: Record<string, string> = {
    "pi-coding-agent": "0.86.1",
    typebox: "1.3.34",
    "spec-kit": "0.8.7",
    superpowers: "6.4.1",
    herdr: "0.9.1",
    codex: "0.155.1",
    devin: "3000.10.31",
    claude: "2.1.234",
  };
  const report = () => ({
    byId: Object.fromEntries([
      ...Object.entries(versions).map(([id, version]) => [id, { id, status: "present" as const, version }]),
      ["pi-multi-agent-harness", installed
        ? { id: "pi-multi-agent-harness", status: "present" as const, version: "0.1.0" }
        : { id: "pi-multi-agent-harness", status: "missing" as const }],
    ]),
  });
  const result = await bootstrap(
    { root, yes: true },
    {
      baseline: builtInBaseline(),
      probe: async () => report(),
      presenter: { show: async () => undefined },
      approvals: {
        requirePlanHash: async (planHash) => ({ approved: true, planHash }),
      },
      executor: {
        process,
        receipts: new ReceiptStore(join(root, ".harness/receipts.jsonl")),
        verifySource: async () => true,
        afterInstall: async () => { installed = true; },
      },
    },
  );
  expect(result.status).toBe("installed");
  expect(process.calls[0]).toMatchObject({
    executable: "pi",
    argv: ["install", "-l", "npm:pi-multi-agent-harness@0.1.0"],
    options: { shell: false },
  });
  expect(JSON.parse(await readFile(join(root, ".pi/settings.json"), "utf8")).packages)
    .toHaveLength(1);
});
