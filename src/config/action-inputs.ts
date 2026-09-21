import { Type, type Static, type TSchema } from "typebox";
import { validator } from "../contracts/common.js";

const EmptyInputSchema = Type.Object({}, { additionalProperties: false });

export const BuiltInActionInputSchemas = {
  "command.run": Type.Object(
    {
      argv: Type.Array(Type.String(), { minItems: 1 }),
      cwd: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      probe: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    },
    { additionalProperties: false },
  ),
  "human.approval": EmptyInputSchema,
  "spec-kit.specify": EmptyInputSchema,
  "spec-kit.plan": EmptyInputSchema,
  "spec-kit.tasks": EmptyInputSchema,
  "worker.execute": EmptyInputSchema,
  "worker.review": EmptyInputSchema,
  "git.verify": EmptyInputSchema,
  "git.integrate": EmptyInputSchema,
  "git.project-task-status": EmptyInputSchema,
  "git.push": EmptyInputSchema,
  "github.pull-request": EmptyInputSchema,
} as const satisfies Readonly<Record<string, TSchema>>;

export type CommandRunInput = Static<
  (typeof BuiltInActionInputSchemas)["command.run"]
>;

export function validateActionInput(
  kind: string,
  input: unknown,
  schemas: Readonly<Record<string, TSchema>>,
): Record<string, unknown> {
  const schema = schemas[kind];
  if (!schema) throw new Error(`unknown action kind: ${kind}`);
  try {
    return validator(schema)(input) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid input for ${kind}: ${message}`);
  }
}
