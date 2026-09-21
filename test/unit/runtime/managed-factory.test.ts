import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createManagedPiRuntimeFromResolved } from "../../../src/runtime/managed/factory.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("rejects a recovery package whose frozen transport identity is unavailable", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "harness-managed-factory-"));
  temporary.push(packageRoot);
  await mkdir(join(packageRoot, "dist", "pi"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "pi-multi-agent-harness", version: "0.1.0" })}\n`,
  );
  await writeFile(
    join(packageRoot, "dist", "pi", "worker-transport-extension.js"),
    "export {};\n",
  );

  await expect(createManagedPiRuntimeFromResolved({
    runtimeVersion: "0.1.0",
    packageRoot,
    profiles: fixtureResolvedProfiles(),
    expectedPackage: {
      name: "pi-multi-agent-harness",
      version: "0.1.0",
      transportHash: `sha256:${"0".repeat(64)}`,
    },
  })).rejects.toThrow("frozen harness transport identity is unavailable");
});
