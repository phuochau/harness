import type { WorkerAssignment } from "../../core/assignment.js";
import {
  JsonResultWorkerAdapter,
  type WorkerDescriptor,
} from "./json-result-adapter.js";
import type { NativeAgentSession } from "./types.js";

function policy(assignment: WorkerAssignment): readonly string[] {
  return assignment.role === "implementation"
    ? ["--sandbox", "workspace-write", "--ask-for-approval", "never"]
    : ["--sandbox", "read-only", "--ask-for-approval", "never"];
}

const descriptor: WorkerDescriptor = {
  kind: "codex",
  executable: "codex",
  versionArgs: ["--version"],
  authArgs: ["login", "status"],
  nativeResume: true,
  sandbox: true,
  launchArgs: (assignment) => [...policy(assignment), "--no-alt-screen"],
  resumeArgs: (assignment, session: NativeAgentSession) => [
    "resume",
    session.value,
    ...policy(assignment),
    "--no-alt-screen",
  ],
};

export class CodexAdapter extends JsonResultWorkerAdapter {
  public readonly kind = "codex" as const;
  protected readonly descriptor = descriptor;
}

