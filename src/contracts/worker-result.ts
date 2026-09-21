import { Type, type Static } from "typebox";
import { HashSchema, VersionSchema, validator } from "./common.js";

export const EvidenceSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    sha256: HashSchema,
  },
  { additionalProperties: false },
);

export const BlockerSchema = Type.Object(
  {
    reason: Type.String({ minLength: 1 }),
    evidence: Type.Array(Type.String()),
    suggestedChange: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const WorkerResultSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: VersionSchema,
      assignmentHash: HashSchema,
      role: Type.Literal("implementation"),
      outcome: Type.Literal("completed"),
      commit: Type.String({ minLength: 1 }),
      evidence: Type.Array(EvidenceSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: VersionSchema,
      assignmentHash: HashSchema,
      role: Type.Literal("review"),
      outcome: Type.Literal("approved"),
      reviewedCommit: Type.String({ minLength: 1 }),
      findings: Type.Array(Type.String()),
      evidence: Type.Array(EvidenceSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: VersionSchema,
      assignmentHash: HashSchema,
      role: Type.Literal("review"),
      outcome: Type.Literal("changes_requested"),
      reviewedCommit: Type.String({ minLength: 1 }),
      findings: Type.Array(Type.String(), { minItems: 1 }),
      evidence: Type.Array(EvidenceSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: VersionSchema,
      assignmentHash: HashSchema,
      outcome: Type.Literal("blocked"),
      blocker: BlockerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: VersionSchema,
      assignmentHash: HashSchema,
      outcome: Type.Literal("failed"),
      reason: Type.String({ minLength: 1 }),
      evidence: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

export type WorkerResult = Static<typeof WorkerResultSchema>;
export const validateWorkerResult = validator(WorkerResultSchema);
