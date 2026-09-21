import { Type, type Static } from "typebox";
import { validator } from "./common.js";

const PackagePathSchema = Type.String({ minLength: 1 });
export const PiResourcesSchema = Type.Object(
  {
    extensions: Type.Optional(
      Type.Array(PackagePathSchema, { minItems: 1, uniqueItems: true }),
    ),
    skills: Type.Optional(
      Type.Array(PackagePathSchema, { minItems: 1, uniqueItems: true }),
    ),
    prompts: Type.Optional(
      Type.Array(PackagePathSchema, { minItems: 1, uniqueItems: true }),
    ),
    themes: Type.Optional(
      Type.Array(PackagePathSchema, { minItems: 1, uniqueItems: true }),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const PiPackageRequirementSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    dependency: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    scope: Type.Literal("project"),
    resources: PiResourcesSchema,
  },
  { additionalProperties: false },
);

export const AgentPluginRequirementSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    dependency: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    agent: Type.Union([
      Type.Literal("pi"),
      Type.Literal("codex"),
      Type.Literal("devin"),
      Type.Literal("claude"),
    ]),
    plugin_id: Type.String({ pattern: "^[A-Za-z0-9@._/-]+$" }),
  },
  { additionalProperties: false },
);

export const EnvironmentSchema = Type.Object(
  {
    schema: Type.Literal("harness/environment/v1"),
    commands: Type.Record(
      Type.String({ pattern: "^[a-z][a-z0-9_]*$" }),
      Type.Array(Type.String(), { minItems: 1 }),
    ),
    pi_packages: Type.Array(PiPackageRequirementSchema),
    agent_plugins: Type.Optional(Type.Array(AgentPluginRequirementSchema)),
  },
  { additionalProperties: false },
);

export type EnvironmentDocument = Static<typeof EnvironmentSchema>;
export const validateEnvironment = validator(EnvironmentSchema);
