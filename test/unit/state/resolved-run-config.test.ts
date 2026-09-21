import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import {
  readResolvedRunConfig,
  writeResolvedRunConfig,
} from "../../../src/state/resolved-run-config.js";
import { fixtureCompileInput } from "../../support/factories.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("persists an immutable compiled workflow and command snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolved-config-"));
  temporary.push(root);
  const path = join(root, "run", "resolved-config.json");
  const value = {
    schemaVersion: 1 as const,
    runtime: {
      harnessVersion: "0.1.0",
      packageName: "pi-multi-agent-harness",
      packageVersion: "0.1.0",
      packageRoot: process.cwd(),
      transportHash: `sha256:${"b".repeat(64)}` as const,
    },
    workflow: compileWorkflow(fixtureCompileInput()),
    commands: { task_verify: ["npm", "test"] },
  };

  await expect(writeResolvedRunConfig(path, value)).resolves.toEqual(value);
  await expect(readResolvedRunConfig(path)).resolves.toEqual(value);
  await expect(writeResolvedRunConfig(path, {
    ...value,
    commands: { task_verify: ["npm", "run", "changed"] },
  })).rejects.toThrow(/does not match/);
});

it("rejects a compiled workflow whose revision no longer matches its content", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolved-config-"));
  temporary.push(root);
  const path = join(root, "resolved-config.json");
  const workflow = compileWorkflow(fixtureCompileInput());
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    runtime: {
      harnessVersion: "0.1.0",
      packageName: "pi-multi-agent-harness",
      packageVersion: "0.1.0",
      packageRoot: process.cwd(),
      transportHash: `sha256:${"b".repeat(64)}`,
    },
    workflow: { ...workflow, name: "tampered" },
    commands: {},
  }));

  await expect(readResolvedRunConfig(path)).rejects.toThrow(/revision/);
  expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
});
