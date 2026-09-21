import { Type, type Static } from "typebox";
import { HashSchema, validator } from "./common.js";

export const TaskNodeSchema = Type.Object(
  {
    id: Type.String({ pattern: "^T[0-9]{3,}$" }),
    description: Type.String({ minLength: 1 }),
    phase: Type.String({ minLength: 1 }),
    labels: Type.Array(Type.String(), { uniqueItems: true }),
    parallelEligible: Type.Boolean(),
    dependsOn: Type.Array(Type.String(), { uniqueItems: true }),
    acceptanceRefs: Type.Array(
      Type.String({ pattern: "^(FR|SC)-[0-9]{3}$" }),
      { uniqueItems: true },
    ),
    ownedPaths: Type.Array(Type.String(), { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const TaskGraphSchema = Type.Object(
  {
    schema: Type.Literal("harness/task-graph/v1"),
    tasksSemanticHash: HashSchema,
    tasks: Type.Array(TaskNodeSchema),
  },
  { additionalProperties: false },
);

export type TaskNode = Static<typeof TaskNodeSchema>;
export type TaskGraphDocument = Static<typeof TaskGraphSchema>;
export const validateTaskGraph = validator(TaskGraphSchema);
