import { Type, type Static } from "typebox";
import { validator } from "./common.js";

export const ProfileFamilySchema = Type.String({ pattern: "^[a-z][a-z0-9-]*$" });

export const ProfileRoleSchema = Type.Union([
  Type.Literal("planning"),
  Type.Literal("implementation"),
  Type.Literal("review"),
]);

export const SkillTargetSchema = Type.Union([
  Type.Literal("pi"),
  Type.Literal("provider"),
]);

const SymbolicResourceIdSchema = Type.String({ minLength: 1 });
const SkillSchema = Type.Object(
  {
    id: SymbolicResourceIdSchema,
    targets: Type.Array(SkillTargetSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export const ProfileSchema = Type.Object(
  {
    family: ProfileFamilySchema,
    integration: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]*$" })),
    runtime: Type.Literal("pi"),
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinking: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
    role: ProfileRoleSchema,
    environment: Type.Literal("isolated"),
    tools: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    extensions: Type.Array(SymbolicResourceIdSchema, { uniqueItems: true }),
    skills: Type.Array(SkillSchema),
    context_files: Type.Literal(false),
    prompt_templates: Type.Array(SymbolicResourceIdSchema, {
      uniqueItems: true,
    }),
    mcp: Type.Array(SymbolicResourceIdSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const ProfilesSchema = Type.Object(
  {
    schema: Type.Literal("harness/profiles/v1"),
    profiles: Type.Record(
      Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
      ProfileSchema,
      { minProperties: 1 },
    ),
  },
  { additionalProperties: false },
);

export type ProfileFamily = Static<typeof ProfileFamilySchema>;
export type ProfileRole = Static<typeof ProfileRoleSchema>;
export type SkillTarget = Static<typeof SkillTargetSchema>;
export type ProfileDocument = Static<typeof ProfilesSchema>;
export const validateProfiles = validator(ProfilesSchema);
