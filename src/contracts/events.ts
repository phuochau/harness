import { Type, type Static, type TSchema } from "typebox";
import {
  HashSchema,
  JsonValueSchema,
  VersionSchema,
  validator,
} from "./common.js";
import { ControllerCommandSchema } from "./controller-command.js";
import { BlockerSchema, WorkerResultSchema } from "./worker-result.js";

const EventEnvelopeProperties = {
  schemaVersion: VersionSchema,
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: Type.String({ format: "date-time" }),
  runId: Type.String({ minLength: 1 }),
  entityId: Type.String({ minLength: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
  fencingToken: Type.Integer({ minimum: 1 }),
  prevHash: HashSchema,
  eventHash: HashSchema,
};

function event<T extends string, P extends TSchema>(eventType: T, payload: P) {
  return Type.Object(
    {
      ...EventEnvelopeProperties,
      eventType: Type.Literal(eventType),
      payload,
    },
    { additionalProperties: false },
  );
}

export const RecoveryClassSchema = Type.Union([
  Type.Literal("idempotent"),
  Type.Literal("reconcilable"),
  Type.Literal("non_retryable"),
]);
export type RecoveryClass = Static<typeof RecoveryClassSchema>;

export const EffectIntentPayloadSchema = Type.Object(
  {
    action: Type.String({ minLength: 1 }),
    idempotencyKey: Type.String({ minLength: 1 }),
    recovery: RecoveryClassSchema,
    laneKey: Type.String({ minLength: 1 }),
    input: JsonValueSchema,
  },
  { additionalProperties: false },
);
export type EffectIntentPayload = Static<typeof EffectIntentPayloadSchema>;
const EffectObservationPayloadSchema = Type.Object(
  {
    action: Type.String({ minLength: 1 }),
    intentKey: Type.String({ minLength: 1 }),
    output: JsonValueSchema,
  },
  { additionalProperties: false },
);
const EffectFailurePayloadSchema = Type.Object(
  {
    action: Type.String({ minLength: 1 }),
    intentKey: Type.String({ minLength: 1 }),
    code: Type.String({ minLength: 1 }),
    evidence: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const DecisionEventDraftSchema = Type.Object(
  {
    eventType: Type.String({ minLength: 1 }),
    entityId: Type.String({ minLength: 1 }),
    idempotencyKey: Type.String({ minLength: 1 }),
    payload: JsonValueSchema,
  },
  { additionalProperties: false },
);
export const CommandDecisionBatchSchema = Type.Object(
  {
    commandKey: Type.String({ minLength: 1 }),
    acceptedSequence: Type.Integer({ minimum: 1 }),
    acceptedAt: Type.String({ format: "date-time" }),
    stateRevision: Type.Integer({ minimum: 1 }),
    decisionHash: HashSchema,
    events: Type.Array(DecisionEventDraftSchema),
    effects: Type.Array(EffectIntentPayloadSchema),
  },
  { additionalProperties: false },
);
export type DecisionEventDraft = Static<typeof DecisionEventDraftSchema>;
export type CommandDecisionBatch = Static<typeof CommandDecisionBatchSchema>;

const OperatorIntentPayloadSchema = Type.Object(
  {
    operation: Type.Union([
      Type.Literal("retry"),
      Type.Literal("reroute"),
      Type.Literal("cancel"),
      Type.Literal("pause"),
      Type.Literal("resume"),
    ]),
    target: Type.String({ minLength: 1 }),
    arguments: Type.Record(Type.String(), JsonValueSchema),
  },
  { additionalProperties: false },
);
const PlanningStageSchema = Type.Union([
  Type.Literal("specify"),
  Type.Literal("plan"),
  Type.Literal("tasks"),
]);
const PlanningMarkerPayloadSchema = Type.Object(
  {
    stage: PlanningStageSchema,
    sessionFile: Type.String({ minLength: 1 }),
    correlationId: Type.String({ minLength: 1 }),
    requestEntryId: Type.String({ minLength: 1 }),
    command: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const PlanningSettledPayloadSchema = Type.Object(
  {
    correlationId: Type.String({ minLength: 1 }),
    finalTurnIndex: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const PlanningRecoveredPayloadSchema = Type.Object(
  {
    correlationId: Type.String({ minLength: 1 }),
    finalTurnIndex: Type.Integer({ minimum: 0 }),
    terminalEntryId: Type.String({ minLength: 1 }),
    terminalEntryHash: HashSchema,
  },
  { additionalProperties: false },
);
const PlanningCompletedPayloadSchema = Type.Union([
  Type.Object(
    {
      stage: Type.Union([Type.Literal("specify"), Type.Literal("plan")]),
      correlationId: Type.String({ minLength: 1 }),
      hashes: Type.Record(Type.String(), HashSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      stage: Type.Literal("tasks"),
      correlationId: Type.String({ minLength: 1 }),
      commit: Type.String({ minLength: 1 }),
      hashes: Type.Record(Type.String(), HashSchema),
    },
    { additionalProperties: false },
  ),
]);

export const HarnessEventSchema = Type.Union([
  event(
    "run.created",
    Type.Object({ workflowRevision: HashSchema }, { additionalProperties: false }),
  ),
  event(
    "controller.command_received",
    Type.Object(
      { command: ControllerCommandSchema },
      { additionalProperties: false },
    ),
  ),
  event("controller.command_decided", CommandDecisionBatchSchema),
  event(
    "controller.command_processed",
    Type.Object(
      { source: Type.String(), commandKey: Type.String() },
      { additionalProperties: false },
    ),
  ),
  event("job.ready", Type.Object({}, { additionalProperties: false })),
  event(
    "attempt.started",
    Type.Object(
      { attempt: Type.Integer({ minimum: 1 }), worker: Type.String() },
      { additionalProperties: false },
    ),
  ),
  event(
    "worker.routed",
    Type.Object(
      { worker: Type.String(), reason: Type.String() },
      { additionalProperties: false },
    ),
  ),
  event("worker.result_observed", WorkerResultSchema),
  event(
    "review.approved",
    Type.Object(
      { commit: Type.String(), reviewer: Type.String() },
      { additionalProperties: false },
    ),
  ),
  event(
    "review.changes_requested",
    Type.Object(
      {
        commit: Type.String(),
        reviewer: Type.String(),
        findings: Type.Array(Type.String(), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "verification.passed",
    Type.Object(
      { commit: Type.String(), evidence: Type.Array(Type.String()) },
      { additionalProperties: false },
    ),
  ),
  event(
    "verification.failed",
    Type.Object(
      {
        commit: Type.String(),
        evidence: Type.Array(Type.String(), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "integration.observed",
    Type.Object(
      {
        candidateCommit: Type.String(),
        candidateRef: Type.String(),
        expectedRunHead: Type.String(),
        patchId: Type.String(),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "integration.conflicted",
    Type.Object(
      {
        sourceBase: Type.String(),
        sourceHead: Type.String(),
        patchId: Type.String(),
        evidence: Type.Array(Type.String(), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  event(
    "task.finalized",
    Type.Object(
      {
        taskId: Type.String(),
        candidateCommit: Type.String(),
        targetCommit: Type.String(),
        tasksSemanticHash: HashSchema,
      },
      { additionalProperties: false },
    ),
  ),
  event("effect.intent", EffectIntentPayloadSchema),
  event("effect.observed", EffectObservationPayloadSchema),
  event("effect.failed", EffectFailurePayloadSchema),
  event("operator.intent", OperatorIntentPayloadSchema),
  event("planning.queued", PlanningMarkerPayloadSchema),
  event("planning.agent_settled", PlanningSettledPayloadSchema),
  event("planning.transcript_recovered", PlanningRecoveredPayloadSchema),
  event("planning.completed", PlanningCompletedPayloadSchema),
  event("planning.blocked", BlockerSchema),
  event("job.done", Type.Object({}, { additionalProperties: false })),
  event(
    "job.invalidated",
    Type.Object(
      {
        supersededGeneration: Type.Integer({ minimum: 1 }),
        reason: Type.String(),
      },
      { additionalProperties: false },
    ),
  ),
  event("job.blocked", BlockerSchema),
  event(
    "job.failed",
    Type.Object({ reason: Type.String() }, { additionalProperties: false }),
  ),
]);

export type HarnessEvent = Static<typeof HarnessEventSchema>;
export const validateHarnessEvent = validator(HarnessEventSchema);
