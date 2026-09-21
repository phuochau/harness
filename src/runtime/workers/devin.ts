import type { WorkerAssignment } from "../../core/assignment.js";
import {
  JsonResultWorkerAdapter,
  type WorkerDescriptor,
} from "./json-result-adapter.js";
import type { NativeAgentSession } from "./types.js";

function policy(assignment: WorkerAssignment): readonly string[] {
  return assignment.role === "implementation"
    ? ["--sandbox", "--permission-mode", "accept-edits"]
    : ["--sandbox", "--permission-mode", "auto"];
}

const descriptor: WorkerDescriptor = {
  kind: "devin",
  executable: "devin",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  nativeResume: true,
  sandbox: true,
  launchArgs: policy,
  resumeArgs: (assignment, session: NativeAgentSession) => [
    "--resume",
    session.value,
    ...policy(assignment),
  ],
};

export class DevinAdapter extends JsonResultWorkerAdapter {
  public readonly kind = "devin" as const;
  protected readonly descriptor = descriptor;
}

