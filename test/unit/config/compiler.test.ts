import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import {
  compileInputCase,
  fixtureCompileInput,
  fixtureLockedProfileResources,
  fixtureProfiles,
} from "../../support/factories.js";
import { resolveProfiles } from "../../../src/config/profiles.js";

it("resolves named argv commands and returns a frozen revision", () => {
  const compiled = compileWorkflow(fixtureCompileInput());
  expect(compiled.stages[0]?.action.input.argv).toEqual(["npm", "test"]);
  expect(compiled.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(compiled.stages)).toBe(true);
  expect(() => {
    (compiled.stages as unknown[]).push({});
  }).toThrow();
});

it("rejects unknown references and stage cycles", () => {
  expect(() => compileWorkflow(compileInputCase("unknown_command"))).toThrow(
    /unknown command/,
  );
  expect(() => compileWorkflow(compileInputCase("cycle"))).toThrow(/cycle/);
});

it("rejects invalid action inputs and graph relationships", () => {
  const unknownAction = structuredClone(fixtureCompileInput());
  unknownAction.workflow.stages[0]!.uses = "unknown.action";
  expect(() => compileWorkflow(unknownAction)).toThrow(/unknown action/);

  const extraInput = structuredClone(fixtureCompileInput());
  extraInput.workflow.stages[0]!.with = {
    argv: "${commands.task_verify}",
    shell: true,
  };
  expect(() => compileWorkflow(extraInput)).toThrow(/additional properties|shell/);

  const unknownDependency = structuredClone(fixtureCompileInput());
  unknownDependency.workflow.stages[1]!.needs = [
    { stage: "missing", scope: "all" },
  ];
  expect(() => compileWorkflow(unknownDependency)).toThrow(/unknown dependency/);

  const duplicate = structuredClone(fixtureCompileInput());
  duplicate.workflow.stages[1]!.id = duplicate.workflow.stages[0]!.id;
  expect(() => compileWorkflow(duplicate)).toThrow(/duplicate stage/);

  const badJoin = structuredClone(fixtureCompileInput());
  badJoin.workflow.stages[1]!.needs = [
    { stage: badJoin.workflow.stages[0]!.id, scope: "same-item" },
  ];
  expect(() => compileWorkflow(badJoin)).toThrow(/same-item/);
});

it("hashes normalized content deterministically and includes command changes", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
      (argv) => {
        const left = structuredClone(fixtureCompileInput());
        left.environment.commands.task_verify = argv;
        const right = {
          actionSchemas: left.actionSchemas!,
          profiles: left.profiles!,
          environment: {
            pi_packages: left.environment.pi_packages,
            ...(left.environment.agent_plugins === undefined
              ? {}
              : { agent_plugins: left.environment.agent_plugins }),
            commands: { ...left.environment.commands },
            schema: left.environment.schema,
          },
          workflow: {
            stages: left.workflow.stages,
            name: left.workflow.name,
            task_model: left.workflow.task_model!,
            schema: left.workflow.schema,
          },
        };
        expect(compileWorkflow(left).revision).toBe(
          compileWorkflow(right).revision,
        );
      },
    ),
  );

  const changed = structuredClone(fixtureCompileInput());
  changed.environment.commands.task_verify = ["npm", "run", "changed"];
  expect(compileWorkflow(fixtureCompileInput()).revision).not.toBe(
    compileWorkflow(changed).revision,
  );
});

it("freezes active-run profiles and records their independent hash", () => {
  const run = compileWorkflow(fixtureCompileInput());
  const editedDocument = structuredClone(fixtureProfiles());
  editedDocument.profiles["planner-codex"]!.model = "openai-codex/changed";
  const edited = resolveProfiles(
    editedDocument,
    fixtureLockedProfileResources(),
  );

  expect(run.resolvedProfilesHash).not.toBe(edited.hash);
  expect(run.profiles.byId["planner-codex"]?.model).toBe(
    "openai-codex/gpt-5.6-luna",
  );
  expect(Object.isFrozen(run.profiles)).toBe(true);
});

describe("complexity-tiered runners", () => {
  const tieredRunner = () => ({
    by_complexity: {
      mechanical: ["implementer-codex"],
      standard: ["implementer-devin"],
      complex: ["implementer-claude"],
    },
  });

  function withRunner(stageId: string, runner: unknown) {
    const input = structuredClone(fixtureCompileInput());
    const stage = input.workflow.stages.find((item) => item.id === stageId);
    if (stage === undefined) throw new Error(`fixture lacks stage ${stageId}`);
    (stage as { runner: unknown }).runner = runner;
    return input;
  }

  it("accepts an exact three-tier runner on a task-scoped worker.execute stage", () => {
    const compiled = compileWorkflow(withRunner("implement", tieredRunner()));
    const implement = compiled.stages.find((stage) => stage.id === "implement")!;
    expect(implement.runner).toEqual(tieredRunner());
  });

  it("lists every declared tier candidate in tier order for preview and assembly", async () => {
    const { stageProfileIds } = await import("../../../src/contracts/index.js");
    const compiled = compileWorkflow(
      withRunner("implement", {
        by_complexity: {
          mechanical: ["implementer-devin"],
          standard: ["implementer-codex"],
          complex: ["implementer-claude"],
        },
      }),
    );
    const stage = (id: string) =>
      compiled.stages.find((item) => item.id === id)!;
    expect(stageProfileIds(stage("implement"))).toEqual([
      "implementer-devin",
      "implementer-codex",
      "implementer-claude",
    ]);
    expect(stageProfileIds(stage("tasks"))).toEqual(["planner-codex"]);
    expect(stageProfileIds(stage("review"))).toEqual([
      "reviewer-codex",
      "reviewer-claude",
      "reviewer-devin",
    ]);
    expect(stageProfileIds(stage("verify"))).toEqual([]);
  });

  it("rejects tiered runners with missing or empty tiers and extra keys", () => {
    for (const mutate of [
      (runner: { by_complexity: Record<string, string[]> }) => {
        delete runner.by_complexity["complex"];
      },
      (runner: { by_complexity: Record<string, string[]> }) => {
        runner.by_complexity["mechanical"] = [];
      },
      (runner: { by_complexity: Record<string, string[]> }) => {
        runner.by_complexity["expert"] = ["implementer-codex"];
      },
      (runner: Record<string, unknown>) => {
        runner["fallback"] = ["implementer-codex"];
      },
      (runner: Record<string, unknown>) => {
        runner["prefer"] = ["implementer-codex"];
      },
    ]) {
      const runner = tieredRunner();
      mutate(runner);
      expect(() => compileWorkflow(withRunner("implement", runner))).toThrow();
    }
  });

  it("rejects a profile declared in multiple complexity tiers", () => {
    const runner = tieredRunner();
    runner.by_complexity.complex = ["implementer-codex"];
    expect(() => compileWorkflow(withRunner("implement", runner))).toThrow(
      /multiple complexity tiers/,
    );
  });

  it("rejects tiered runners with unknown profiles or wrong roles", () => {
    const unknown = tieredRunner();
    unknown.by_complexity.standard = ["implementer-ghost"];
    expect(() => compileWorkflow(withRunner("implement", unknown))).toThrow(
      /unknown profile implementer-ghost/,
    );

    const reviewer = tieredRunner();
    reviewer.by_complexity.complex = ["reviewer-codex"];
    expect(() => compileWorkflow(withRunner("implement", reviewer))).toThrow(
      /expected implementation/,
    );
  });

  it("rejects tiered runners outside task-scoped worker.execute stages", () => {
    const onReview = withRunner("review", {
      by_complexity: {
        mechanical: ["reviewer-codex"],
        standard: ["reviewer-claude"],
        complex: ["reviewer-devin"],
      },
    });
    expect(() => compileWorkflow(onReview)).toThrow(
      /task-scoped worker\.execute/,
    );

    const onPlanning = withRunner("tasks", tieredRunner());
    expect(() => compileWorkflow(onPlanning)).toThrow(
      /task-scoped worker\.execute/,
    );

    const singleton = structuredClone(fixtureCompileInput());
    singleton.workflow.stages.push({
      id: "solo_implement",
      uses: "worker.execute",
      runner: tieredRunner(),
    } as unknown as (typeof singleton.workflow.stages)[number]);
    expect(() => compileWorkflow(singleton)).toThrow(
      /task-scoped worker\.execute/,
    );
  });

  it("keeps legacy string and prefer runner forms unchanged", () => {
    const compiled = compileWorkflow(fixtureCompileInput());
    const stage = (id: string) =>
      compiled.stages.find((item) => item.id === id)!;
    expect(stage("tasks").runner).toBe("planner-codex");
    expect(stage("implement").runner).toEqual({
      prefer: ["implementer-devin", "implementer-codex", "implementer-claude"],
    });
    expect(stage("review").runner).toEqual({
      prefer: ["reviewer-codex", "reviewer-claude", "reviewer-devin"],
    });
  });
});
