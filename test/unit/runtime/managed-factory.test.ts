import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createManagedPiRuntimeFromResolved,
  managedRuntimeHash,
} from "../../../src/runtime/managed/factory.js";
import { sha256 } from "../../../src/shared/sha256.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("rejects recovery from a different package root", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "harness-managed-factory-"));
  temporary.push(packageRoot);
  await expect(createManagedPiRuntimeFromResolved({
    runtimeVersion: "0.1.0",
    packageRoot,
    profiles: fixtureResolvedProfiles(),
    expectedPackage: {
      name: "pi-multi-agent-harness",
      version: "0.1.0",
      transportHash: `sha256:${"0".repeat(64)}`,
      runtimeHash: `sha256:${"1".repeat(64)}`,
    },
  })).rejects.toThrow("recovery must run from the frozen harness package root");
});

it("rejects a recovery package whose frozen transport identity is unavailable", async () => {
  await expect(createManagedPiRuntimeFromResolved({
    runtimeVersion: "0.1.0",
    packageRoot: process.cwd(),
    profiles: fixtureResolvedProfiles(),
    expectedPackage: {
      name: "pi-multi-agent-harness",
      version: "0.1.0",
      transportHash: `sha256:${"0".repeat(64)}`,
      runtimeHash: `sha256:${"1".repeat(64)}`,
    },
  })).rejects.toThrow("frozen harness transport identity is unavailable");
});

it("rejects a recovery package whose frozen supervisor identity is unavailable", async () => {
  const packageRoot = process.cwd();
  const transportHash = sha256(await readFile(
    join(packageRoot, "dist", "pi", "worker-transport-extension.js"),
  ));
  await expect(createManagedPiRuntimeFromResolved({
    runtimeVersion: "0.1.0",
    packageRoot,
    profiles: fixtureResolvedProfiles(),
    expectedPackage: {
      name: "pi-multi-agent-harness",
      version: "0.1.0",
      transportHash,
      runtimeHash: `sha256:${"1".repeat(64)}`,
    },
  })).rejects.toThrow("frozen harness runtime identity is unavailable");
});

it("hashes every executable dist module used by recovery", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "harness-runtime-hash-"));
  temporary.push(packageRoot);
  await Promise.all([
    mkdir(join(packageRoot, "bin"), { recursive: true }),
    mkdir(join(packageRoot, "dist", "runtime", "pi-worker"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(packageRoot, "bin", "harness.mjs"), "export {};\n"),
    writeFile(join(packageRoot, "bin", "pi-process-monitor.mjs"), "export {};\n"),
    writeFile(join(packageRoot, "dist", "runtime", "pi-worker", "runtime.js"), "export const value = 1;\n"),
  ]);
  const before = await managedRuntimeHash(packageRoot);
  await writeFile(
    join(packageRoot, "dist", "runtime", "pi-worker", "runtime.js"),
    "export const value = 2;\n",
  );
  await expect(managedRuntimeHash(packageRoot)).resolves.not.toBe(before);
});
