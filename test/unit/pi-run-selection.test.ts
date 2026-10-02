import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compileWorkflow } from "../../src/config/compile.js";
import {
  buildRunPreview,
  compileRunSelection,
} from "../../src/pi/run-selection.js";
import type { RunRequest } from "../../src/pi/run-request.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import { sha256 } from "../../src/shared/sha256.js";
import type { WorkflowDocument } from "../../src/contracts/index.js";
import {
  fixtureEnvironment,
  fixtureResolvedProfiles,
  fixtureWorkflow,
} from "../support/factories.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const largeDocument: WorkflowDocument = {
  schema: "harness/v1",
  name: "fixture-large",
  stages: [
    { id: "specify", uses: "spec-kit.specify", runner: "planner-codex" },
    {
      id: "verify",
      uses: "command.run",
      needs: [{ stage: "specify", scope: "all" }],
      with: { argv: "${commands.full_verify}" },
    },
  ],
};

function quickPresetYaml(declaredKind: string): string {
  return `schema: harness/v1
name: fixture-quick-${declaredKind}
task_model:
  source: stages.quick_plan.outputs.graph
  complete_when: { stage: verify_all }
stages:
  - id: quick_plan
    uses: harness.quick-plan
    runner: planner-codex
    with: { kind: ${declaredKind} }
    produces:
      spec: specs/feature/spec.md
      plan: specs/feature/plan.md
      tasks: specs/feature/tasks.md
      graph: specs/feature/task-graph.json
  - id: verify_all
    uses: command.run
    needs: [{ stage: quick_plan, scope: all }]
    with: { argv: "\${commands.full_verify}" }
`;
}

async function projectWithPresets(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-selection-"));
  temporary.push(root);
  await mkdir(join(root, ".harness/workflows"), { recursive: true });
  await writeFile(
    join(root, ".harness/workflows/bugfix.yaml"),
    quickPresetYaml("bugfix"),
    "utf8",
  );
  await writeFile(
    join(root, ".harness/workflows/small-feature.yaml"),
    quickPresetYaml("small-feature"),
    "utf8",
  );
  return root;
}

async function selectionContext(root: string) {
  return {
    root,
    workflowDocument: largeDocument,
    defaultWorkflow: compileWorkflow({
      workflow: largeDocument,
      environment: fixtureEnvironment(),
      profiles: fixtureResolvedProfiles(),
    }),
    environment: fixtureEnvironment(),
    profiles: fixtureResolvedProfiles(),
  };
}

it("returns the unchanged legacy workflow for an unflagged run", async () => {
  const root = await projectWithPresets();
  const context = await selectionContext(root);
  const selected = await compileRunSelection(context, {
    runId: "F100",
    kind: "large-feature",
  });
  expect(selected).toBe(context.defaultWorkflow);
});

it("injects a literal brief into spec-kit.specify for a flagged large run", async () => {
  const root = await projectWithPresets();
  const context = await selectionContext(root);
  const brief = 'literal ${commands.task_verify} and "quotes" stay data';
  const selected = await compileRunSelection(context, {
    runId: "F100",
    kind: "large-feature",
    brief,
  });
  expect(selected.revision).not.toBe(context.defaultWorkflow.revision);
  const specify = selected.stages.find((stage) => stage.uses === "spec-kit.specify")!;
  expect(specify.action.input.brief).toBe(brief);
});

it("compiles the trusted quick preset and binds kind plus literal brief", async () => {
  const root = await projectWithPresets();
  const context = await selectionContext(root);
  const brief = 'fix the crash; $(literal) ${not.a.reference} stays';
  const request: RunRequest = { runId: "F100", kind: "bugfix", brief };
  const selected = await compileRunSelection(context, request);
  const quick = selected.stages.find(
    (stage) => stage.uses === "harness.quick-plan",
  )!;
  expect(quick.id).toBe("quick_plan");
  expect(quick.action.input).toEqual({ kind: "bugfix", brief });
  for (const artifact of ["spec", "plan", "tasks", "graph"] as const) {
    expect(quick.produces?.[artifact]).toBe(`specs/feature/${artifact === "graph" ? "task-graph.json" : `${artifact}.md`}`);
  }
});

it("produces a different workflow revision when the brief changes", async () => {
  const root = await projectWithPresets();
  const context = await selectionContext(root);
  const first = await compileRunSelection(context, {
    kind: "bugfix",
    brief: "first brief",
  });
  const second = await compileRunSelection(context, {
    kind: "bugfix",
    brief: "second brief",
  });
  expect(first.revision).not.toBe(second.revision);
});

it("rejects a quick preset that declares a different kind", async () => {
  const root = await projectWithPresets();
  await writeFile(
    join(root, ".harness/workflows/small-feature.yaml"),
    quickPresetYaml("bugfix"),
    "utf8",
  );
  const context = await selectionContext(root);
  await expect(
    compileRunSelection(context, { kind: "small-feature", brief: "x" }),
  ).rejects.toThrow(/kind|preset/);
});

it("rejects a quick preset with multiple planning stages before run initialization", async () => {
  const root = await projectWithPresets();
  await writeFile(
    join(root, ".harness/workflows/bugfix.yaml"),
    quickPresetYaml("bugfix") +
      "  - id: second_quick\n    uses: harness.quick-plan\n    runner: planner-codex\n    with: { kind: bugfix }\n",
    "utf8",
  );
  const context = await selectionContext(root);
  await expect(
    compileRunSelection(context, { kind: "bugfix", brief: "Fix the crash" }),
  ).rejects.toThrow(/exactly one.*harness\.quick-plan/i);
});

it("fails with a repair message when the quick preset is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-selection-"));
  temporary.push(root);
  await mkdir(join(root, ".harness/workflows"), { recursive: true });
  const context = await selectionContext(root);
  await expect(
    compileRunSelection(context, { kind: "bugfix", brief: "fix it" }),
  ).rejects.toThrow(/bugfix\.yaml.*harness init|harness init.*bugfix\.yaml|large-feature/);
});

it("binds kind, brief, and workflow revision into the preview", async () => {
  const root = await projectWithPresets();
  const context = await selectionContext(root);
  const commands = { task_verify: ["npm", "test"] };
  const bugfix = await compileRunSelection(context, {
    kind: "bugfix",
    brief: "fix it",
  });
  const request: RunRequest = { kind: "bugfix", brief: "fix it" };
  const preview = buildRunPreview(request, bugfix, commands, []);
  expect(preview.kind).toBe("bugfix");
  expect(preview.brief).toBe("fix it");
  expect(preview.workflowHash).toBe(bugfix.revision);
  expect(preview.effects).toContain("harness.quick-plan");
  expect(preview.commands).toEqual(commands);
});

it("includes every complexity tier profile in the approval preview", () => {
  const fixture = fixtureWorkflow();
  const workflow = compileWorkflow({
    workflow: {
      ...fixture,
      stages: fixture.stages.map((stage) => stage.id === "implement"
        ? {
            ...stage,
            runner: {
              by_complexity: {
                mechanical: ["implementer-codex"],
                standard: ["implementer-devin"],
                complex: ["implementer-claude"],
              },
            },
          }
        : stage),
    },
    environment: fixtureEnvironment(),
    profiles: fixtureResolvedProfiles(),
  });
  const preview = buildRunPreview({ kind: "large-feature" }, workflow, {}, []);
  expect(preview.workers).toEqual(expect.arrayContaining([
    "implementer-codex",
    "implementer-devin",
    "implementer-claude",
  ]));
});

it("changes the approval hash when the kind or brief changes", async () => {
  const root = await projectWithPresets();
  const context = await selectionContext(root);
  const commands = { task_verify: ["npm", "test"] };
  const select = async (request: RunRequest) =>
    buildRunPreview(
      request,
      await compileRunSelection(context, request),
      commands,
      [],
    );
  const bugfixA = await select({ kind: "bugfix", brief: "fix A" });
  const bugfixB = await select({ kind: "bugfix", brief: "fix B" });
  const smallA = await select({ kind: "small-feature", brief: "fix A" });
  const hashes = [bugfixA, bugfixB, smallA].map((preview) =>
    sha256(canonicalJson(preview)),
  );
  expect(new Set(hashes).size).toBe(3);
  const repeat = await select({ kind: "bugfix", brief: "fix A" });
  expect(sha256(canonicalJson(repeat))).toBe(hashes[0]);
});
