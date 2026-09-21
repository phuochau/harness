import type { AssignmentInput, WorkerAssignment } from "../../src/core/assignment.js";
import { createAssignment } from "../../src/core/assignment.js";
import type { ProcessRunner } from "../../src/actions/types.js";
import type {
  NativeAgentSession,
  WorkerProbeContext,
} from "../../src/runtime/workers/types.js";
import { assignmentFixture } from "./controller-fixtures.js";
import { completedResult } from "./factories.js";
import { FakeProcessRunner } from "./fake-process.js";

export function contractAssignment(
  overrides: Partial<AssignmentInput> = {},
): WorkerAssignment {
  return createAssignment({ ...assignmentFixture(), ...overrides });
}

export function workerProbeContext(
  process: ProcessRunner = new FakeProcessRunner(),
): WorkerProbeContext {
  return {
    cwd: "/repo",
    process,
    env: {},
  };
}

export function nativeSessionRef(
  kind: string,
  assignment: WorkerAssignment,
): NativeAgentSession {
  return {
    source: `herdr:${kind}`,
    agent: kind,
    kind: "id",
    value: "session-1",
    assignmentHash: assignment.assignmentHash,
    attempt: assignment.attempt,
  };
}

export function completedResultText(assignment: WorkerAssignment): string {
  return JSON.stringify(
    completedResult({ assignmentHash: assignment.assignmentHash }),
  );
}

