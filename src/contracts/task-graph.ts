import { Type, type Static } from "typebox";
import { HashSchema, validator } from "./common.js";

export const TaskComplexitySchema = Type.Union([
  Type.Literal("mechanical"),
  Type.Literal("standard"),
  Type.Literal("complex"),
]);
export type TaskComplexity = Static<typeof TaskComplexitySchema>;

export const complexityReasonMaxLength = 500;

const taskNodeFields = {
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
};

export const TaskNodeSchema = Type.Object(taskNodeFields, {
  additionalProperties: false,
});

export const TaskNodeV2Schema = Type.Object(
  {
    ...taskNodeFields,
    complexity: TaskComplexitySchema,
    complexityReason: Type.String({
      minLength: 1,
      maxLength: complexityReasonMaxLength,
    }),
  },
  { additionalProperties: false },
);

export const TaskGraphV1Schema = Type.Object(
  {
    schema: Type.Literal("harness/task-graph/v1"),
    tasksSemanticHash: HashSchema,
    tasks: Type.Array(TaskNodeSchema),
  },
  { additionalProperties: false },
);

export const TaskGraphV2Schema = Type.Object(
  {
    schema: Type.Literal("harness/task-graph/v2"),
    tasksSemanticHash: HashSchema,
    tasks: Type.Array(TaskNodeV2Schema),
  },
  { additionalProperties: false },
);

export const TaskGraphSchema = Type.Union([TaskGraphV1Schema, TaskGraphV2Schema]);

export type TaskNodeV1 = Static<typeof TaskNodeSchema>;
export type TaskNodeV2 = Static<typeof TaskNodeV2Schema>;
export type TaskNode = TaskNodeV1 | TaskNodeV2;
export type TaskGraphV1Document = Static<typeof TaskGraphV1Schema>;
export type TaskGraphV2Document = Static<typeof TaskGraphV2Schema>;
export type TaskGraphDocument = Static<typeof TaskGraphSchema>;
export const validateTaskGraph = validator(TaskGraphSchema);

export function taskComplexity(task: TaskNode): TaskComplexity | undefined {
  return "complexity" in task ? task.complexity : undefined;
}
