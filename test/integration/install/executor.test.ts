import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  executeInstallPlan,
  InstallApprovalError,
  InstallVerificationError,
  ManualInstallRequiredError,
} from "../../../src/install/executor.js";
import { installPlanHash, type InstallPlan } from "../../../src/install/plan.js";
import {
  mergePiPackageSettings,
  PiSettingsConflictError,
} from "../../../src/install/pi-settings.js";
import { ReceiptStore } from "../../../src/install/receipts.js";
import { FakeProcessRunner } from "../../support/fake-process.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function automaticPlan(): InstallPlan {
  const body = {
    schemaVersion: 1,
    lockHash: `sha256:${"a".repeat(64)}`,
    warnings: [],
    steps: [
      {
        id: "tool",
        mode: "automatic",
        blocking: true,
        executable: "npm",
        argv: [
          "install",
          "--global",
          "--ignore-scripts",
          "--registry=https://registry.npmjs.org/",
          "tool@1.2.3",
        ],
        environment: {
          NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
          npm_config_registry: "https://registry.npmjs.org/",
        },
        cwd: "trusted-install-root",
        scope: "global",
        source: {
          kind: "npm",
          identity: "tool",
          version: "1.2.3",
          integrity: "sha512-safe",
        },
        expectedVersion: "1.2.3",
        expectedMutations: ["global npm prefix"],
        probeAfter: "tool",
        rollback: "npm uninstall --global tool",
      },
    ],
  } as const;
  return { ...body, planHash: installPlanHash(body) };
}

it("never invokes a shell or repository lifecycle script", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-install-"));
  temporary.push(root);
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "installed", stderr: "" });
  await executeInstallPlan(
    automaticPlan(),
    { approved: true, planHash: automaticPlan().planHash },
    {
      root,
      process,
      probe: async () => ({ id: "tool", status: "present", version: "1.2.3" }),
      receipts: new ReceiptStore(join(root, "receipts.jsonl")),
      verifySource: async () => true,
    },
  );
  expect(process.calls[0]).toMatchObject({
    executable: "npm",
    options: {
      shell: false,
      env: {
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
        npm_config_registry: "https://registry.npmjs.org/",
      },
    },
  });
  expect(process.calls[0]!.argv).toContain("--ignore-scripts");
});

it("is receipt-idempotent and never records command output secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-install-"));
  temporary.push(root);
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "token=secret", stderr: "" });
  const receipts = new ReceiptStore(join(root, "receipts.jsonl"));
  const dependencies = {
    root,
    process,
    probe: async () => ({ id: "tool", status: "present" as const, version: "1.2.3" }),
    receipts,
    verifySource: async () => true,
  };
  const plan = automaticPlan();
  await executeInstallPlan(plan, { approved: true, planHash: plan.planHash }, dependencies);
  await executeInstallPlan(plan, { approved: true, planHash: plan.planHash }, dependencies);
  expect(process.calls).toHaveLength(1);
  expect(await readFile(join(root, "receipts.jsonl"), "utf8")).not.toContain("secret");
});

it("writes a partial failed receipt when post-install verification fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-install-"));
  temporary.push(root);
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "", stderr: "" });
  const plan = automaticPlan();
  const receipts = new ReceiptStore(join(root, "receipts.jsonl"));
  await expect(
    executeInstallPlan(
      plan,
      { approved: true, planHash: plan.planHash },
      {
        root,
        process,
        probe: async () => ({ id: "tool", status: "missing" }),
        receipts,
        verifySource: async () => true,
      },
    ),
  ).rejects.toBeInstanceOf(InstallVerificationError);
  expect(await readFile(join(root, "receipts.jsonl"), "utf8")).toContain('"status":"failed"');
});

it("requires the isolated resource loader check after the inert post-probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-install-"));
  temporary.push(root);
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "", stderr: "" });
  const plan = automaticPlan();
  const receipts = new ReceiptStore(join(root, "receipts.jsonl"));
  await expect(
    executeInstallPlan(
      plan,
      { approved: true, planHash: plan.planHash },
      {
        root,
        process,
        probe: async () => ({ id: "tool", status: "present", version: "1.2.3" }),
        receipts,
        verifySource: async () => true,
        verifyLoaded: async () => false,
      },
    ),
  ).rejects.toBeInstanceOf(InstallVerificationError);
  expect(await readFile(join(root, "receipts.jsonl"), "utf8"))
    .toContain("isolated loader verification failed");
});

it("requires approval of the exact content-addressed plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-install-"));
  temporary.push(root);
  const plan = automaticPlan();
  await expect(
    executeInstallPlan(
      plan,
      { approved: true, planHash: `sha256:${"c".repeat(64)}` },
      {
        root,
        process: new FakeProcessRunner(),
        probe: async () => ({ id: "tool", status: "present", version: "1.2.3" }),
        receipts: new ReceiptStore(join(root, "receipts.jsonl")),
        verifySource: async () => true,
      },
    ),
  ).rejects.toBeInstanceOf(InstallApprovalError);
});

it("preflights manual blockers before executing any automatic step", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-install-"));
  temporary.push(root);
  const process = new FakeProcessRunner();
  const base = automaticPlan();
  const body = {
    schemaVersion: base.schemaVersion,
    lockHash: base.lockHash,
    warnings: base.warnings,
    steps: [
      ...base.steps,
      { id: "unknown", mode: "manual", blocking: true, reason: "unverified" },
    ],
  } as const;
  const plan: InstallPlan = { ...body, planHash: installPlanHash(body) };
  await expect(
    executeInstallPlan(plan, { approved: true, planHash: plan.planHash }, {
      root,
      process,
      probe: async () => ({ id: "tool", status: "present", version: "1.2.3" }),
      receipts: new ReceiptStore(join(root, "receipts.jsonl")),
      verifySource: async () => true,
    }),
  ).rejects.toBeInstanceOf(ManualInstallRequiredError);
  expect(process.calls).toHaveLength(0);
});

it("atomically projects all Pi filters and requires repair for customization", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-install-"));
  temporary.push(root);
  const entry = {
    source: "npm:pi-multi-agent-harness@0.1.0",
    extensions: ["+dist/pi/extension.js"],
    skills: [],
    prompts: [],
    themes: [],
  };
  await mergePiPackageSettings({ root, entry, declaredSources: [entry.source] });
  expect(JSON.parse(await readFile(join(root, ".pi/settings.json"), "utf8"))).toMatchObject({
    packages: [entry],
  });

  const customized = { ...entry, extensions: [] };
  await expect(
    mergePiPackageSettings({ root, entry: customized, declaredSources: [entry.source] }),
  ).rejects.toBeInstanceOf(PiSettingsConflictError);
  await mergePiPackageSettings({
    root,
    entry: customized,
    declaredSources: [entry.source],
    repair: true,
  });
  expect(JSON.parse(await readFile(join(root, ".pi/settings.json"), "utf8")).packages[0])
    .toEqual(customized);
});
