import fc from "fast-check";
import { expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import {
  compileInputCase,
  fixtureCompileInput,
} from "../../support/factories.js";

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
          environment: {
            pi_packages: left.environment.pi_packages,
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
