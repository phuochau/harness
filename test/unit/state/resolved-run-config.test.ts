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

async function resolvedConfig(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-resolved-config-"));
  temporary.push(root);
  return {
    root,
    value: {
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
      ...overrides,
    },
  };
}

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

it("round-trips a frozen profile capability snapshot", async () => {
  const profileCapabilities = {
    "implementer-fast": {
      available: true,
      evidence: ["managed profile resources verified"],
    },
    "implementer-strong": {
      available: false,
      evidence: [
        "managed resource is missing",
        "managed model catalog is missing",
      ],
    },
  };
  const { root, value } = await resolvedConfig({ profileCapabilities });
  const path = join(root, "resolved-config.json");

  await writeResolvedRunConfig(path, value);
  const resolved = await readResolvedRunConfig(path);
  expect(resolved.profileCapabilities).toEqual(profileCapabilities);
  expect(Object.isFrozen(resolved)).toBe(true);
  expect(Object.isFrozen(resolved.profileCapabilities)).toBe(true);
  expect(
    Object.isFrozen(resolved.profileCapabilities?.["implementer-fast"]),
  ).toBe(true);
  expect(
    Object.isFrozen(
      resolved.profileCapabilities?.["implementer-fast"]?.evidence,
    ),
  ).toBe(true);
});

it("keeps legacy resolved records without a capability snapshot valid", async () => {
  const { root, value } = await resolvedConfig();
  const path = join(root, "resolved-config.json");
  await writeFile(path, JSON.stringify(value));

  const resolved = await readResolvedRunConfig(path);
  expect(resolved.schemaVersion).toBe(1);
  expect(resolved.profileCapabilities).toBeUndefined();
  expect(resolved.workflow.revision).toBe(value.workflow.revision);
});

it("rejects snapshot entries carrying credentials or prompt material", async () => {
  const { root, value } = await resolvedConfig({
    profileCapabilities: {
      "implementer-fast": {
        available: true,
        evidence: ["managed profile resources verified"],
        apiKey: "sk-test-secret",
        prompt: "implement this task",
      },
    },
  });
  const path = join(root, "resolved-config.json");
  await writeFile(path, JSON.stringify(value));

  await expect(readResolvedRunConfig(path)).rejects.toThrow(
    /capability snapshot/,
  );
});

it.each([
  ["an array snapshot", []],
  ["a non-record entry", { "implementer-fast": "available" }],
  [
    "a non-boolean availability flag",
    { "implementer-fast": { available: "yes", evidence: [] } },
  ],
  [
    "non-array evidence",
    { "implementer-fast": { available: true, evidence: "verified" } },
  ],
  [
    "non-string evidence entries",
    { "implementer-fast": { available: true, evidence: [42] } },
  ],
  [
    "an invalid profile id key",
    { "Implementer Fast": { available: true, evidence: ["verified"] } },
  ],
  [
    "prompt-sized multiline evidence",
    {
      "implementer-fast": {
        available: true,
        evidence: [`line one\n${"x".repeat(400)}`],
      },
    },
  ],
  [
    "an entry with extra fields",
    {
      "implementer-fast": {
        available: true,
        evidence: ["verified"],
        token: "secret",
      },
    },
  ],
])("rejects malformed capability snapshots: %s", async (_name, snapshot) => {
  const { root, value } = await resolvedConfig({
    profileCapabilities: snapshot,
  });
  const path = join(root, "resolved-config.json");
  await writeFile(path, JSON.stringify(value));

  await expect(readResolvedRunConfig(path)).rejects.toThrow(
    /capability snapshot/,
  );
});
