import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initProject } from "../../../src/cli/init.js";
import {
  probeEnvironment,
  probeExecutable,
} from "../../../src/install/probes.js";
import { FakeProcessRunner } from "../../support/fake-process.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), "harness probe "));
  temporary.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
    "utf8",
  );
  await initProject({ root });
  return root;
}

async function cachedHarness(root: string, extension = true) {
  const packageRoot = join(root, ".pi/npm/pi-multi-agent-harness");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pi-multi-agent-harness", version: "0.1.0" }),
    "utf8",
  );
  if (extension) {
    await mkdir(join(packageRoot, "dist/pi"), { recursive: true });
    await writeFile(
      join(packageRoot, "dist/pi/extension.js"),
      "throw new Error('probe imported package code');\n",
      "utf8",
    );
  }
  return packageRoot;
}

it("reports a declared Pi package whose required extension is absent", async () => {
  const root = await projectFixture();
  await cachedHarness(root, false);
  const report = await probeEnvironment({
    root,
    process: new FakeProcessRunner(),
    capabilities: [],
  });
  expect(report.byId["pi-package:harness"]).toMatchObject({
    status: "missing",
    missingResources: ["dist/pi/extension.js"],
  });
});

it("reads Pi package metadata without importing extension code", async () => {
  const root = await projectFixture();
  await cachedHarness(root, true);
  const report = await probeEnvironment({
    root,
    process: new FakeProcessRunner(),
    capabilities: [],
  });
  expect(report.byId["pi-package:harness"]).toMatchObject({ status: "present" });
});

it("blocks a repository-controlled Pi package-manager command", async () => {
  const root = await projectFixture();
  const path = join(root, ".pi/settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  settings.npmCommand = ["./owned"];
  await writeFile(path, JSON.stringify(settings), "utf8");
  const report = await probeEnvironment({
    root,
    process: new FakeProcessRunner(),
    capabilities: [],
  });
  expect(report.byId["pi-settings:npm-command"]).toMatchObject({
    status: "policy_violation",
  });
});

it("rejects a package cache resource that escapes through a symlink", async () => {
  const root = await projectFixture();
  const packageRoot = await cachedHarness(root, false);
  const outside = await mkdtemp(join(tmpdir(), "harness-probe-outside-"));
  temporary.push(outside);
  await writeFile(join(outside, "extension.js"), "export default {};\n", "utf8");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await symlink(outside, join(packageRoot, "dist/pi"));
  const report = await probeEnvironment({
    root,
    process: new FakeProcessRunner(),
    capabilities: [],
  });
  expect(report.byId["pi-package:harness"]?.status).toBe("unverifiable");
});

it("runs executable probes shell-free and redacts auth output", async () => {
  const root = await projectFixture();
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "tool 1.2.3\n", stderr: "" });
  process.queue({ exitCode: 0, stdout: "token=secret-value\n", stderr: "" });
  const report = await probeEnvironment({
    root,
    process,
    capabilities: [
      {
        id: "tool",
        command: "tool",
        versionArgs: ["--version"],
        parseVersion: (stdout) => /([0-9]+\.[0-9]+\.[0-9]+)/.exec(stdout)?.[1],
        expectedVersion: "1.2.3",
        auth: { args: ["auth", "status"], isAuthenticated: () => true },
      },
    ],
  });
  expect(report.byId.tool).toMatchObject({ status: "present", version: "1.2.3" });
  expect(report.byId["auth:tool"]).toEqual({ id: "auth:tool", status: "present" });
  expect(JSON.stringify(report)).not.toContain("secret-value");
  expect(process.calls.every((call) => call.options.shell === false)).toBe(true);
});

it("applies minimum-version constraints during executable probing", async () => {
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "v22.19.0\n", stderr: "" });
  const results = await probeExecutable(process, {
    id: "node",
    command: "node",
    versionArgs: ["--version"],
    expectedVersion: ">=22.22.2",
    parseVersion: (stdout) => /v(\d+\.\d+\.\d+)/.exec(stdout)?.[1],
  });
  expect(results[0]).toMatchObject({
    id: "node",
    status: "wrong_version",
    version: "22.19.0",
  });
});

it("probes exact managed provider packages without importing their extensions", async () => {
  const root = await projectFixture();
  const managed = join(root, "managed-packages");
  for (const [name, version, extension] of [
    ["@tian.zuo/pi-devin-acp", "0.3.4", "index.ts"],
    ["pi-claude-bridge", "0.8.0", "src/index.ts"],
  ] as const) {
    const packageRoot = join(managed, "node_modules", name);
    await mkdir(dirname(join(packageRoot, extension)), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name, version }),
      "utf8",
    );
    await writeFile(join(packageRoot, extension), "throw new Error('must not import')", "utf8");
  }
  await writeFile(
    join(managed, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/@tian.zuo/pi-devin-acp": {
          integrity: "sha512-su1j4yDc8nSvHvx4eFvyXp2BAHFjArThdKUzEoy+v/AnLUKx6E39bFXzS0RZGTweueddKKdhiihEeK5yWaH1nQ==",
        },
        "node_modules/pi-claude-bridge": {
          integrity: "sha512-CaSXdCdMWLGcvvG4IZuKeyUIyLio2m8nEO7cUFZdxKPdkwWuf8Eq46Ys2z3VlSjCidlIpasLwiCdJStXSt6EZQ==",
        },
      },
    }),
    "utf8",
  );
  const report = await probeEnvironment({
    root,
    managedPackagesRoot: managed,
    process: new FakeProcessRunner(),
    capabilities: [],
  });
  expect(report.byId["pi-devin-acp"]).toMatchObject({
    status: "present",
    version: "0.3.4",
  });
  expect(report.byId["pi-claude-bridge"]).toMatchObject({
    status: "present",
    version: "0.8.0",
  });

  const lock = JSON.parse(await readFile(join(managed, "package-lock.json"), "utf8"));
  lock.packages["node_modules/pi-claude-bridge"].integrity = "sha512-tampered";
  await writeFile(join(managed, "package-lock.json"), JSON.stringify(lock), "utf8");
  const tampered = await probeEnvironment({
    root,
    managedPackagesRoot: managed,
    process: new FakeProcessRunner(),
    capabilities: [],
  });
  expect(tampered.byId["pi-claude-bridge"]?.status).toBe("wrong_source");
});
