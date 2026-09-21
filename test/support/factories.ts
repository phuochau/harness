import type {
  EnvironmentDocument,
  JsonValue,
  HarnessEvent,
  HarnessLock,
  ProfileDocument,
  TaskGraphDocument,
  WorkerResult,
  WorkflowDocument,
} from "../../src/contracts/index.js";
import { BuiltInActionInputSchemas } from "../../src/config/action-inputs.js";
import type { CompileInput } from "../../src/config/compile.js";
import {
  resolveProfiles,
  type LockedProfileResources,
  type ResolvedProfiles,
} from "../../src/config/profiles.js";
import type { GraphContext } from "../../src/core/task-graph.js";
import type { DeepPartial } from "./fixture.js";
import { fixture } from "./fixture.js";

const hashA = `sha256:${"a".repeat(64)}` as const;
const hashB = `sha256:${"b".repeat(64)}` as const;

export const fixtureWorkflow = fixture<WorkflowDocument>(() => ({
  schema: "harness/v1",
  name: "fixture-workflow",
  task_model: {
    source: "stages.tasks.outputs.graph",
    complete_when: { stage: "record_task_done" },
  },
  stages: [
    {
      id: "prepare",
      uses: "command.run",
      with: { argv: "${commands.task_verify}" },
    },
    {
      id: "tasks",
      uses: "spec-kit.tasks",
      runner: "planner-codex",
      needs: [{ stage: "prepare", scope: "all" }],
      produces: { graph: "specs/fixture/task-graph.json" },
    },
    {
      id: "implement",
      uses: "worker.execute",
      runner: {
        prefer: [
          "implementer-devin",
          "implementer-codex",
          "implementer-claude",
        ],
      },
      needs: [{ stage: "tasks", scope: "all" }],
      foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
      gate: "task.dependencies_done",
      isolation: "worktree",
      retry: { max_attempts: 3, max_elapsed_seconds: 3600 },
    },
    {
      id: "review",
      uses: "worker.review",
      runner: {
        prefer: ["reviewer-codex", "reviewer-claude", "reviewer-devin"],
      },
      needs: [{ stage: "implement", scope: "same-item" }],
      foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
      policies: { require_different_profile_family: true, scope: "task" },
      retry: { max_attempts: 3, max_elapsed_seconds: 3600 },
      on_failure: { changes_requested: { retry_stage: "implement" } },
    },
    {
      id: "verify",
      uses: "command.run",
      needs: [{ stage: "review", scope: "same-item" }],
      foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
      with: { argv: "${commands.task_verify}" },
      retry: { max_attempts: 3, max_elapsed_seconds: 3600 },
      on_failure: { verification_failed: { retry_stage: "implement" } },
    },
    {
      id: "integrate",
      uses: "git.integrate",
      needs: [{ stage: "verify", scope: "same-item" }],
      foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
    },
    {
      id: "post_integrate_verify",
      uses: "command.run",
      needs: [{ stage: "integrate", scope: "same-item" }],
      foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
      with: { argv: "${commands.task_verify}" },
    },
    {
      id: "record_task_done",
      uses: "git.project-task-status",
      needs: [{ stage: "post_integrate_verify", scope: "same-item" }],
      foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
    },
    {
      id: "final_verify",
      uses: "command.run",
      needs: [{ stage: "record_task_done", scope: "all" }],
      with: { argv: "${commands.full_verify}" },
    },
    {
      id: "final_review",
      uses: "worker.review",
      runner: {
        prefer: ["reviewer-codex", "reviewer-claude", "reviewer-devin"],
      },
      needs: [{ stage: "final_verify", scope: "all" }],
      policies: { scope: "final_diff" },
    },
    {
      id: "push",
      uses: "git.push",
      needs: [{ stage: "final_review", scope: "all" }],
    },
    {
      id: "final_pr",
      uses: "github.pull-request",
      needs: [{ stage: "push", scope: "all" }],
    },
  ],
}));

export const fixtureEnvironment = fixture<EnvironmentDocument>(() => ({
  schema: "harness/environment/v1",
  commands: {
    task_verify: ["npm", "test"],
    full_verify: ["npm", "run", "verify"],
  },
  pi_packages: [
    {
      id: "harness",
      dependency: "harness",
      scope: "project",
      resources: { extensions: ["dist/pi/extension.js"] },
    },
  ],
  agent_plugins: [],
}));

export const fixtureProfiles = fixture<ProfileDocument>(() => ({
  schema: "harness/profiles/v1",
  profiles: {
    "planner-codex": {
      family: "codex",
      runtime: "pi",
      provider: "openai-codex",
      model: "openai-codex/gpt-5.6-luna",
      thinking: "high",
      role: "planning",
      environment: "isolated",
      tools: ["read", "write"],
      extensions: [],
      skills: [],
      context_files: false,
      prompt_templates: ["spec-kit"],
      mcp: [],
    },
    "implementer-devin": {
      family: "devin",
      runtime: "pi",
      provider: "devin",
      model: "devin/swe-2",
      role: "implementation",
      environment: "isolated",
      tools: ["read", "bash", "edit", "write"],
      extensions: ["devin-acp"],
      skills: [
        {
          id: "superpowers:test-driven-development",
          targets: ["pi", "provider"],
        },
      ],
      context_files: false,
      prompt_templates: [],
      mcp: [],
    },
    "implementer-codex": {
      family: "codex",
      runtime: "pi",
      provider: "openai-codex",
      model: "openai-codex/gpt-5.6-luna",
      role: "implementation",
      environment: "isolated",
      tools: ["read", "bash", "edit", "write"],
      extensions: [],
      skills: [
        { id: "superpowers:test-driven-development", targets: ["pi"] },
      ],
      context_files: false,
      prompt_templates: [],
      mcp: [],
    },
    "implementer-claude": {
      family: "claude",
      runtime: "pi",
      provider: "claude-bridge",
      model: "claude-bridge/claude-sonnet-5",
      role: "implementation",
      environment: "isolated",
      tools: ["read", "bash", "edit", "write"],
      extensions: ["claude-bridge"],
      skills: [
        {
          id: "superpowers:test-driven-development",
          targets: ["pi", "provider"],
        },
      ],
      context_files: false,
      prompt_templates: [],
      mcp: [],
    },
    "reviewer-codex": {
      family: "codex",
      runtime: "pi",
      provider: "openai-codex",
      model: "openai-codex/gpt-5.6-luna",
      role: "review",
      environment: "isolated",
      tools: ["read", "bash"],
      extensions: [],
      skills: [],
      context_files: false,
      prompt_templates: [],
      mcp: [],
    },
    "reviewer-claude": {
      family: "claude",
      runtime: "pi",
      provider: "claude-bridge",
      model: "claude-bridge/claude-sonnet-5",
      role: "review",
      environment: "isolated",
      tools: ["read", "bash"],
      extensions: ["claude-bridge"],
      skills: [],
      context_files: false,
      prompt_templates: [],
      mcp: [],
    },
    "reviewer-devin": {
      family: "devin",
      runtime: "pi",
      provider: "devin",
      model: "devin/swe-2",
      role: "review",
      environment: "isolated",
      tools: ["read", "bash"],
      extensions: ["devin-acp"],
      skills: [],
      context_files: false,
      prompt_templates: [],
      mcp: [],
    },
  },
}));

export const fixtureLockedProfileResources = fixture<LockedProfileResources>(() => ({
  extensions: {
    "devin-acp": "/managed/extensions/devin-acp/index.js",
    "claude-bridge": "/managed/extensions/claude-bridge/index.js",
  },
  skills: {
    "superpowers:test-driven-development":
      "/managed/skills/test-driven-development/SKILL.md",
  },
  promptTemplates: { "spec-kit": "/managed/prompts/spec-kit.md" },
  mcp: {},
}));

export const fixtureResolvedProfiles = fixture<ResolvedProfiles>(() =>
  resolveProfiles(fixtureProfiles(), fixtureLockedProfileResources()),
);

export const fixtureHarnessLock = fixture<HarnessLock>(() => ({
  schema: "harness/lock/v1",
  harnessVersion: "0.1.0",
  dependencies: [
    {
      id: "harness",
      kind: "pi-package",
      version: "0.1.0",
      source: {
        kind: "npm",
        identity: "pi-multi-agent-harness",
        version: "0.1.0",
        integrity: "sha512-fixture",
      },
      piSource: "pi-multi-agent-harness@0.1.0",
      dependsOn: [],
    },
  ],
}));

function diamondTaskGraphBase(): TaskGraphDocument {
  return {
  schema: "harness/task-graph/v1",
  tasksSemanticHash: hashA,
  tasks: [
    {
      id: "T001",
      description: "one",
      phase: "foundation",
      labels: ["US1"],
      parallelEligible: true,
      dependsOn: [],
      acceptanceRefs: ["FR-001"],
      ownedPaths: ["src/one.ts"],
    },
      {
        id: "T002",
        description: "two",
        phase: "foundation",
        labels: ["US1"],
        parallelEligible: true,
        dependsOn: [],
        acceptanceRefs: ["FR-002"],
        ownedPaths: ["src/two.ts"],
      },
      {
        id: "T003",
        description: "three",
        phase: "integration",
        labels: ["US1"],
        parallelEligible: false,
        dependsOn: ["T001", "T002"],
        acceptanceRefs: ["SC-001"],
        ownedPaths: ["src/three.ts"],
      },
    ],
  };
}

export const fixtureTaskGraph = fixture<TaskGraphDocument>(diamondTaskGraphBase);

export function diamondTaskGraph(
  overrides: DeepPartial<TaskGraphDocument> = {},
): TaskGraphDocument {
  return fixture<TaskGraphDocument>(diamondTaskGraphBase)(overrides);
}

export const fixtureEvent = fixture<HarnessEvent>(() => ({
  schemaVersion: 1,
  sequence: 1,
  timestamp: "2026-09-20T00:00:00.000Z",
  runId: "F023",
  entityId: "run:F023",
  idempotencyKey: "run:create",
  fencingToken: 1,
  prevHash: hashA,
  eventHash: hashB,
  eventType: "run.created",
  payload: { workflowRevision: hashA },
}));

export interface FixtureState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workflowRevision: `sha256:${string}`;
  readonly sequence: number;
  readonly eventHash: `sha256:${string}`;
  readonly jobs: Readonly<Record<string, JsonValue>>;
}

export const fixtureState = fixture<FixtureState>(() => ({
  schemaVersion: 1,
  runId: "F023",
  workflowRevision: hashA,
  sequence: 0,
  eventHash: hashA,
  jobs: {},
}));

export const completedResult = fixture<WorkerResult>(() => ({
  schemaVersion: 1,
  assignmentHash: hashA,
  role: "implementation",
  outcome: "completed",
  commit: "0123456789abcdef0123456789abcdef01234567",
  evidence: [
    {
      kind: "superpower:test-driven-development",
      path: ".harness-output/tdd.json",
      sha256: hashB,
    },
    {
      kind: "superpower:verification-before-completion",
      path: ".harness-output/verification.json",
      sha256: hashB,
    },
    {
      kind: "command:npm test",
      path: ".harness-output/test.log",
      sha256: hashB,
    },
  ],
}));

export const fixtureCompileInput = fixture<CompileInput>(() => ({
  workflow: fixtureWorkflow(),
  environment: fixtureEnvironment(),
  profiles: fixtureResolvedProfiles(),
  actionSchemas: BuiltInActionInputSchemas,
}));

export function compileInputCase(
  kind: "unknown_command" | "cycle",
): CompileInput {
  const input = structuredClone(fixtureCompileInput());
  if (kind === "unknown_command") {
    input.workflow.stages[0]!.with = { argv: "${commands.missing}" };
  } else {
    input.workflow.stages[1]!.needs = [
      { stage: input.workflow.stages[1]!.id, scope: "all" },
    ];
  }
  return input;
}

export type TaskGraphCase =
  | "duplicate"
  | "unknown_dependency"
  | "cycle"
  | "changed_owned_path"
  | "unordered_overlap"
  | "ordered_overlap";

export function taskGraphCase(kind: TaskGraphCase): TaskGraphDocument {
  const graph = structuredClone(fixtureTaskGraph());
  switch (kind) {
    case "duplicate":
      graph.tasks.push(structuredClone(graph.tasks[0]!));
      break;
    case "unknown_dependency":
      graph.tasks[2]!.dependsOn = ["T999"];
      break;
    case "cycle":
      graph.tasks[0]!.dependsOn = ["T003"];
      break;
    case "changed_owned_path":
      graph.tasks[0]!.ownedPaths = ["src/not-in-tasks.ts"];
      break;
    case "unordered_overlap":
      graph.tasks[1]!.ownedPaths = [...graph.tasks[0]!.ownedPaths];
      break;
    case "ordered_overlap":
      graph.tasks[2]!.ownedPaths = [...graph.tasks[0]!.ownedPaths];
      break;
  }
  return fixture<TaskGraphDocument>(() => graph)();
}

export function fixtureGraphContext(
  overrides: Partial<GraphContext> = {},
): GraphContext {
  const graph = diamondTaskGraph();
  return {
    tasksSemanticHash: overrides.tasksSemanticHash ?? graph.tasksSemanticHash,
    taskRecords:
      overrides.taskRecords ??
      new Map(
        graph.tasks.map((task) => [task.id, structuredClone(task)] as const),
      ),
    acceptanceRefs:
      overrides.acceptanceRefs ??
      new Set(graph.tasks.flatMap((task) => task.acceptanceRefs)),
  };
}

export function fixtureGraphContextFor(
  graph: TaskGraphDocument,
): GraphContext {
  return {
    tasksSemanticHash: graph.tasksSemanticHash,
    taskRecords: new Map(
      graph.tasks.map((task) => [task.id, structuredClone(task)] as const),
    ),
    acceptanceRefs: new Set(
      graph.tasks.flatMap((task) => task.acceptanceRefs),
    ),
  };
}
