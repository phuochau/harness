import type { AssignmentInput, WorkerAssignment } from "../../src/core/assignment.js";
import { createAssignment } from "../../src/core/assignment.js";
import { assignmentFixture } from "./controller-fixtures.js";
import { completedResult } from "./factories.js";

export function contractAssignment(
  overrides: Partial<AssignmentInput> = {},
): WorkerAssignment {
  const input = { ...assignmentFixture(), ...overrides };
  if (overrides.workerKind !== undefined) {
    input.profileFamily = overrides.workerKind;
    input.profileId = `${input.role === "review" ? "reviewer" : "implementer"}-${overrides.workerKind}`;
  }
  if (overrides.implementationWorkerKind !== undefined) {
    input.implementationProfileFamily = overrides.implementationWorkerKind;
  }
  return createAssignment(input);
}

export function completedResultText(assignment: WorkerAssignment): string {
  return JSON.stringify(
    completedResult({ assignmentHash: assignment.assignmentHash }),
  );
}
