import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compileWorkflow, injectCompiledActionInput } from "../../../src/config/compile.js";
import {
  readResolvedRunConfig,
  validateResolvedRunConfig,
  writeResolvedRunConfig,
} from "../../../src/state/resolved-run-config.js";
import { fixtureCompileInput } from "../../support/factories.js";

function quickWorkflow(brief: string) {
  const fixture = fixtureCompileInput();
  const compiled = compileWorkflow({
    ...fixture,
    workflow: {
      schema: "harness/v1",
      name: "test-bugfix",
      stages: [{
        id: "quick_plan",
        uses: "harness.quick-plan",
        runner: "planner-codex",
        with: { kind: "bugfix" },
      }],
    },
  });
  return injectCompiledActionInput(compiled, "harness.quick-plan", { brief });
}

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
      runtimeHash: `sha256:${"c".repeat(64)}` as const,
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

it("persists and validates the frozen task-kind selection", async () => {
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
      runtimeHash: `sha256:${"c".repeat(64)}` as const,
    },
    workflow: quickWorkflow("fix the crash"),
    commands: { task_verify: ["npm", "test"] },
    selection: { kind: "bugfix" as const, brief: "fix the crash" },
  };
  await expect(writeResolvedRunConfig(path, value)).resolves.toEqual(value);
  await expect(readResolvedRunConfig(path)).resolves.toEqual(value);
});

it("rejects frozen selection metadata that disagrees with its hashed workflow", () => {
  const base = {
    schemaVersion: 1 as const,
    runtime: {
      harnessVersion: "0.1.0",
      packageName: "pi-multi-agent-harness",
      packageVersion: "0.1.0",
      packageRoot: process.cwd(),
      transportHash: `sha256:${"b".repeat(64)}` as const,
      runtimeHash: `sha256:${"c".repeat(64)}` as const,
    },
    workflow: quickWorkflow("fix the crash"),
    commands: {},
  };
  expect(() => validateResolvedRunConfig({ ...base, selection: {
    kind: "small-feature", brief: "fix the crash",
  } })).toThrow(/selection.*workflow|workflow.*selection/i);
  expect(() => validateResolvedRunConfig({ ...base, selection: {
    kind: "bugfix", brief: "different brief",
  } })).toThrow(/selection.*workflow|workflow.*selection/i);
  expect(() => validateResolvedRunConfig(base)).toThrow(/selection.*workflow|workflow.*selection/i);
});

it("rejects malformed task-kind selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolved-config-"));
  temporary.push(root);
  const path = join(root, "resolved-config.json");
  const base = {
    schemaVersion: 1 as const,
    runtime: {
      harnessVersion: "0.1.0",
      packageName: "pi-multi-agent-harness",
      packageVersion: "0.1.0",
      packageRoot: process.cwd(),
      transportHash: `sha256:${"b".repeat(64)}` as const,
      runtimeHash: `sha256:${"c".repeat(64)}` as const,
    },
    workflow: compileWorkflow(fixtureCompileInput()),
    commands: {},
  };
  await expect(
    writeResolvedRunConfig(path, {
      ...base,
      selection: { kind: "hotfix", brief: "x" } as never,
    }),
  ).rejects.toThrow(/selection/i);
  await expect(
    writeResolvedRunConfig(path, {
      ...base,
      selection: { kind: "bugfix" },
    }),
  ).rejects.toThrow(/selection|brief/i);
  await expect(
    writeResolvedRunConfig(path, {
      ...base,
      selection: { kind: "bugfix", brief: "x".repeat(4097) },
    }),
  ).rejects.toThrow(/selection|brief/i);
  await expect(
    writeResolvedRunConfig(path, {
      ...base,
      selection: { kind: "bugfix", brief: "x", extra: true } as never,
    }),
  ).rejects.toThrow(/selection/i);
  await expect(
    writeResolvedRunConfig(path, {
      ...base,
      workflowPath: "evil.yaml",
    } as never),
  ).rejects.toThrow(/fields/);
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
      runtimeHash: `sha256:${"c".repeat(64)}`,
    },
    workflow: { ...workflow, name: "tampered" },
    commands: {},
  }));

  await expect(readResolvedRunConfig(path)).rejects.toThrow(/revision/);
  expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
});
