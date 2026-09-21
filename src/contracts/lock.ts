import { Type, type Static } from "typebox";
import { validator } from "./common.js";

export const LockedSourceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("npm"),
      Type.Literal("git"),
      Type.Literal("formula"),
      Type.Literal("signed-artifact"),
      Type.Literal("manual"),
    ]),
    identity: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    integrity: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const LockedDependencySchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    kind: Type.Union([
      Type.Literal("pi-package"),
      Type.Literal("tool"),
      Type.Literal("integration"),
      Type.Literal("manual"),
    ]),
    version: Type.String({ minLength: 1 }),
    source: LockedSourceSchema,
    piSource: Type.Optional(Type.String({ minLength: 1 })),
    dependsOn: Type.Array(Type.String(), { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const HarnessLockSchema = Type.Object(
  {
    schema: Type.Literal("harness/lock/v1"),
    harnessVersion: Type.String({ minLength: 1 }),
    dependencies: Type.Array(LockedDependencySchema),
  },
  { additionalProperties: false },
);

export type HarnessLock = Static<typeof HarnessLockSchema>;
export type LockedDependency = Static<typeof LockedDependencySchema>;
export const validateHarnessLock = validator(HarnessLockSchema);
