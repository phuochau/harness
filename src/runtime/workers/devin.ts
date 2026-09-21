import type { WorkerAssignment } from "../../core/assignment.js";
import {
  JsonResultWorkerAdapter,
  assignmentFileLaunchPrompt,
  type WorkerDescriptor,
} from "./json-result-adapter.js";
import type { NativeAgentSession } from "./types.js";

function policy(assignment: WorkerAssignment): readonly string[] {
  return [
    "--sandbox",
    "--permission-mode",
    assignment.role === "review" ? "auto" : "accept-edits",
  ];
}

const descriptor: WorkerDescriptor = {
  kind: "devin",
  executable: "devin",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  nativeResume: true,
  sandbox: true,
  launchArgs: (prepared) => [
    ...policy(prepared.assignment),
    "--respect-workspace-trust",
    "false",
    "--print",
    "--",
    assignmentFileLaunchPrompt(prepared),
  ],
  resumeArgs: (assignment, session: NativeAgentSession) => [
    "--resume",
    session.value,
    ...policy(assignment),
    "--respect-workspace-trust",
    "false",
    "--print",
    "--",
    "Continue the staged harness assignment and emit its required result.",
  ],
};

export class DevinAdapter extends JsonResultWorkerAdapter {
  public readonly kind = "devin" as const;
  protected readonly descriptor = descriptor;
}
