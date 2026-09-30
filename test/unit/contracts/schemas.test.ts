import { expect, it } from "vitest";
import {
  validateControllerCommand,
  validateEnvironmentAndLock,
  validateHarnessEvent,
  validateTaskGraph,
  validateWorkerResult,
  validateProfiles,
} from "../../../src/contracts/index.js";
import { canonicalJson } from "../../../src/shared/canonical-json.js";

const hash = `sha256:${"a".repeat(64)}`;

it("rejects short semantic hashes and unknown fields", () => {
  expect(() =>
    validateTaskGraph({
      schema: "harness/task-graph/v1",
      tasksSemanticHash: "invalid-hash",
      tasks: [],
      extra: true,
    }),
  ).toThrow();
});

it("requires typed blockers", () => {
  expect(() =>
    validateWorkerResult({
      schemaVersion: 1,
      assignmentHash: hash,
      outcome: "blocked",
      blocker: { reason: "x" },
    }),
  ).toThrow();
});

it("rejects non-JSON durable command payloads", () => {
  expect(() =>
    validateControllerCommand({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "retry:T001",
      payload: { callback: () => undefined },
    }),
  ).toThrow();
});

it("canonicalizes object keys by locale-independent code-unit order", () => {
  expect(canonicalJson({ ä: 3, z: 2, A: 1 })).toBe(
    '{"A":1,"z":2,"ä":3}',
  );
});

it("rejects Pi package requirements that are not exact lock projections", () => {
  expect(() =>
    validateEnvironmentAndLock(
      {
        schema: "harness/environment/v1",
        commands: {},
        agent_plugins: [],
        pi_packages: [
          {
            id: "harness",
            dependency: "missing",
            scope: "project",
            resources: { extensions: ["dist/pi/extension.js"] },
          },
        ],
      },
      {
        schema: "harness/lock/v1",
        harnessVersion: "0.1.0",
        dependencies: [],
      },
    ),
  ).toThrow(/lock dependency/);
});

it("keeps environment/v1 backward compatible while validating declared agent plugins", () => {
  const lock = {
    schema: "harness/lock/v1",
    harnessVersion: "0.1.0",
    dependencies: [],
  };
  expect(() => validateEnvironmentAndLock({
    schema: "harness/environment/v1",
    commands: {},
    pi_packages: [],
  }, lock)).not.toThrow();
  expect(() => validateEnvironmentAndLock({
    schema: "harness/environment/v1",
    commands: {},
    pi_packages: [],
    agent_plugins: [{
      id: "superpowers-codex",
      dependency: "superpowers",
      agent: "codex",
      plugin_id: "../../escape",
    }],
  }, lock)).toThrow();
  expect(() => validateEnvironmentAndLock({
    schema: "harness/environment/v1",
    commands: {},
    pi_packages: [],
    agent_plugins: [{
      id: "superpowers-codex",
      dependency: "superpowers",
      agent: "codex",
      plugin_id: "superpowers-dev/superpowers",
    }],
  }, lock)).toThrow(/lock dependency/);
});

it("accepts v1 and v2 task graphs, each with a closed shape", () => {
  const v1Node = {
    id: "T001",
    description: "one",
    phase: "foundation",
    labels: [],
    parallelEligible: false,
    dependsOn: [],
    acceptanceRefs: [],
    ownedPaths: [],
  };
  const v2Node = {
    ...v1Node,
    complexity: "standard",
    complexityReason: "Touches one file",
  };
  expect(
    validateTaskGraph({
      schema: "harness/task-graph/v1",
      tasksSemanticHash: hash,
      tasks: [],
    }),
  ).toBeTruthy();
  expect(
    validateTaskGraph({
      schema: "harness/task-graph/v2",
      tasksSemanticHash: hash,
      tasks: [v2Node],
    }),
  ).toBeTruthy();
  expect(() =>
    validateTaskGraph({
      schema: "harness/task-graph/v3",
      tasksSemanticHash: hash,
      tasks: [],
    }),
  ).toThrow();
  expect(() =>
    validateTaskGraph({
      schema: "harness/task-graph/v1",
      tasksSemanticHash: hash,
      tasks: [],
      extra: true,
    }),
  ).toThrow();
  expect(() =>
    validateTaskGraph({
      schema: "harness/task-graph/v1",
      tasksSemanticHash: hash,
      tasks: [v2Node],
    }),
  ).toThrow();
  expect(() =>
    validateTaskGraph({
      schema: "harness/task-graph/v2",
      tasksSemanticHash: hash,
      tasks: [v1Node],
    }),
  ).toThrow();
});

it("rejects malformed event envelopes and action-specific payloads", () => {
  const event = {
    schemaVersion: 1,
    sequence: 0,
    timestamp: "yesterday",
    runId: "F023",
    entityId: "run:F023",
    idempotencyKey: "create",
    fencingToken: -1,
    prevHash: hash,
    eventHash: hash,
    eventType: "run.created",
    payload: {},
  };
  expect(() => validateHarnessEvent(event)).toThrow();
});

it("rejects malformed task IDs and missing worker evidence", () => {
  expect(() =>
    validateTaskGraph({
      schema: "harness/task-graph/v1",
      tasksSemanticHash: hash,
      tasks: [
        {
          id: "1",
          description: "bad id",
          phase: "foundation",
          labels: [],
          parallelEligible: false,
          dependsOn: [],
          acceptanceRefs: [],
          ownedPaths: [],
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    validateWorkerResult({
      schemaVersion: 1,
      assignmentHash: hash,
      role: "implementation",
      outcome: "completed",
      commit: "abc123",
    }),
  ).toThrow();
});

it("rejects empty and unsafe profile family slugs", () => {
  const profile = {
    family: "research-agent", runtime: "pi", provider: "openai-codex",
    model: "gpt-5", role: "planning", environment: "isolated",
    tools: [], extensions: [], skills: [], context_files: false,
    prompt_templates: [], mcp: [],
  };
  for (const family of ["", "Research Agent", "../escape"]) {
    expect(() => validateProfiles({
      schema: "harness/profiles/v1", profiles: { research: { ...profile, family } },
    })).toThrow();
  }
  expect(() => validateProfiles({
    schema: "harness/profiles/v1", profiles: { research: profile },
  })).not.toThrow();
});

it("accepts a closed optional model_config and rejects unknown config keys", () => {
  const profile = {
    family: "qwen", runtime: "pi", provider: "ollama",
    model: "qwen3-coder:30b", role: "implementation", environment: "isolated",
    tools: [], extensions: [], skills: [], context_files: false,
    prompt_templates: [], mcp: [],
  };
  const wrap = (model_config: unknown) => ({
    schema: "harness/profiles/v1",
    profiles: { local: { ...profile, model_config } },
  });
  expect(() => validateProfiles(wrap({
    base_url: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    name: "Qwen3-Coder 30B",
    api_key_env: "OLLAMA_API_KEY",
  }))).not.toThrow();
  for (const model_config of [
    { base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", extra: true },
    { base_url: "http://127.0.0.1:11434/v1", api: "anthropic-messages" },
    { base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", api_key_env: "!command" },
    { api: "openai-completions" },
  ]) {
    expect(() => validateProfiles(wrap(model_config))).toThrow();
  }
});
