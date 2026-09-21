import type { WorkerAssignment } from "../../core/assignment.js";
import { validateWorkerResult } from "../../contracts/worker-result.js";
import type { ParsedWorkerResult } from "./types.js";

export function parseWorkerResult(
  raw: string,
  assignment: WorkerAssignment,
): ParsedWorkerResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "invalid",
      reason: `result is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const result = validateWorkerResult(parsed);
    if (result.assignmentHash !== assignment.assignmentHash) {
      return { status: "invalid", reason: "result assignment hash mismatch" };
    }
    if (
      result.outcome !== "blocked" &&
      result.outcome !== "failed" &&
      result.role !== assignment.role
    ) {
      return { status: "invalid", reason: "result role does not match assignment" };
    }
    return { status: "valid", result };
  } catch (error) {
    return {
      status: "invalid",
      reason: `result schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
