import { Type, type Static } from "typebox";
import { validator } from "./common.js";

export const NeedSchema = Type.Object(
  {
    stage: Type.String({ minLength: 1 }),
    scope: Type.Union([Type.Literal("same-item"), Type.Literal("all")]),
  },
  { additionalProperties: false },
);

export const RunnerSchema = Type.Union([
  Type.Literal("pi"),
  Type.Object(
    {
      prefer: Type.Array(
        Type.Union([
          Type.Literal("codex"),
          Type.Literal("devin"),
          Type.Literal("claude"),
        ]),
        { minItems: 1 },
      ),
    },
    { additionalProperties: false },
  ),
]);

const ForeachSchema = Type.Object(
  { source: Type.String({ minLength: 1 }), key: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const RetryStageSchema = Type.Object(
  { retry_stage: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const StageSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }),
    uses: Type.String({ minLength: 1 }),
    runner: Type.Optional(RunnerSchema),
    needs: Type.Optional(Type.Array(NeedSchema)),
    model_profile: Type.Optional(Type.String({ minLength: 1 })),
    foreach: Type.Optional(ForeachSchema),
    gate: Type.Optional(Type.String({ minLength: 1 })),
    isolation: Type.Optional(Type.Literal("worktree")),
    profile: Type.Optional(Type.String({ minLength: 1 })),
    if: Type.Optional(
      Type.Object(
        { expression: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
    with: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    policies: Type.Optional(
      Type.Object(
        {
          require_different_worker_kind: Type.Optional(Type.Boolean()),
          scope: Type.Optional(
            Type.Union([Type.Literal("task"), Type.Literal("final_diff")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    produces: Type.Optional(Type.Record(Type.String(), Type.String())),
    retry: Type.Optional(
      Type.Object(
        {
          max_attempts: Type.Integer({ minimum: 1 }),
          max_elapsed_seconds: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    timeout: Type.Optional(Type.Integer({ minimum: 1 })),
    on_failure: Type.Optional(
      Type.Object(
        {
          changes_requested: Type.Optional(
            Type.Union([
              RetryStageSchema,
              Type.Object(
                { block: Type.String({ minLength: 1 }) },
                { additionalProperties: false },
              ),
            ]),
          ),
          verification_failed: Type.Optional(RetryStageSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const TaskModelSchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    complete_when: Type.Object(
      { stage: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const WorkflowSchema = Type.Object(
  {
    schema: Type.Literal("harness/v1"),
    name: Type.String({ minLength: 1 }),
    task_model: Type.Optional(TaskModelSchema),
    stages: Type.Array(StageSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type StageDocument = Static<typeof StageSchema>;
export type WorkflowDocument = Static<typeof WorkflowSchema>;
export const validateWorkflow = validator(WorkflowSchema);
