import type { WorkerAssignment } from "../../core/assignment.js";
import {
  JsonResultWorkerAdapter,
  assignmentFileLaunchPrompt,
  type WorkerDescriptor,
} from "./json-result-adapter.js";
import type { NativeAgentSession } from "./types.js";

function policy(assignment: WorkerAssignment): readonly string[] {
  return [
    "--permission-mode",
    assignment.role === "review" ? "plan" : "acceptEdits",
  ];
}

const descriptor: WorkerDescriptor = {
  kind: "claude",
  executable: "claude",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  nativeResume: true,
  sandbox: false,
  launchArgs: (prepared) => [
    "--print",
    ...policy(prepared.assignment),
    assignmentFileLaunchPrompt(prepared),
  ],
  resumeArgs: (assignment, session: NativeAgentSession) => [
    "--resume",
    session.value,
    ...policy(assignment),
  ],
};

export class ClaudeAdapter extends JsonResultWorkerAdapter {
  public readonly kind = "claude" as const;
  protected readonly descriptor = descriptor;
}
