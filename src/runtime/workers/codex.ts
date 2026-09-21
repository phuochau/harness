import type { WorkerAssignment } from "../../core/assignment.js";
import {
  JsonResultWorkerAdapter,
  assignmentFileLaunchPrompt,
  type WorkerDescriptor,
} from "./json-result-adapter.js";
import type { NativeAgentSession } from "./types.js";

function policy(assignment: WorkerAssignment): readonly string[] {
  const sandbox = assignment.role === "review" ? "read-only" : "workspace-write";
  return [
    "--sandbox",
    sandbox,
    "--config",
    'approval_policy="never"',
    // Worker prompts invoke the pinned Superpowers skills explicitly. Disable
    // unmanaged lifecycle hooks and repository execution policies.
    "--disable",
    "hooks",
    "--ignore-rules",
  ];
}

const descriptor: WorkerDescriptor = {
  kind: "codex",
  executable: "codex",
  versionArgs: ["--version"],
  authArgs: ["login", "status"],
  nativeResume: true,
  sandbox: true,
  launchArgs: (prepared) => [
    "exec",
    ...policy(prepared.assignment),
    assignmentFileLaunchPrompt(prepared),
  ],
  resumeArgs: (assignment, session: NativeAgentSession) => [
    "exec",
    "resume",
    "--disable",
    "hooks",
    "--ignore-rules",
    "--config",
    `sandbox_mode=${JSON.stringify(assignment.role === "review" ? "read-only" : "workspace-write")}`,
    "--config",
    'approval_policy="never"',
    session.value,
  ],
};

export class CodexAdapter extends JsonResultWorkerAdapter {
  public readonly kind = "codex" as const;
  protected readonly descriptor = descriptor;
}
