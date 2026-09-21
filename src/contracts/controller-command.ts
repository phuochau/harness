import { Type, type Static } from "typebox";
import { JsonValueSchema, VersionSchema, validator } from "./common.js";

export const ControllerCommandSchema = Type.Object(
  {
    schemaVersion: VersionSchema,
    source: Type.Union([
      Type.Literal("controller"),
      Type.Literal("timer"),
      Type.Literal("herdr"),
      Type.Literal("pi"),
      Type.Literal("operator"),
      Type.Literal("recovery"),
    ]),
    kind: Type.Union([
      Type.Literal("effect_result"),
      Type.Literal("tick"),
      Type.Literal("runtime_event"),
      Type.Literal("operator_intent"),
      Type.Literal("planning_turn"),
      Type.Literal("recover"),
    ]),
    idempotencyKey: Type.String({ minLength: 1 }),
    payload: JsonValueSchema,
  },
  { additionalProperties: false },
);

export type ControllerCommand = Static<typeof ControllerCommandSchema>;
export const validateControllerCommand = validator(ControllerCommandSchema);
