import type { WorkerAssignment } from "../../core/assignment.js";
import type { SuperpowersProfile } from "./superpowers-profile.js";

function lines(title: string, values: readonly string[]): string[] {
  return [title, ...(values.length === 0 ? ["- none"] : values.map((value) => `- ${value}`))];
}

export function buildWorkerPrompt(
  assignment: WorkerAssignment,
  profile: SuperpowersProfile,
): string {
  const resultPath = ".harness-output/result.json";
  const writable = assignment.worktree.writable ? assignment.allowedPaths : [];
  const sections = [
    "# Harness worker assignment",
    "",
    `Assignment hash: ${assignment.assignmentHash}`,
    `Run: ${assignment.runId}`,
    `Job: ${assignment.jobId}`,
    `Attempt: ${assignment.attempt}`,
    `Role: ${assignment.role}`,
    `Assigned commit: ${assignment.commit}`,
    `Worktree: ${assignment.worktree.path}`,
    `Result path: ${resultPath}`,
    "",
    ...lines("Readable planning artifacts:", assignment.planningArtifacts),
    "",
    ...lines("Writable paths:", writable),
    "",
    ...assignment.protectedPaths.map((path) => `Do not modify ${path}`),
    "",
    ...lines(
      "Required verification commands (argv, no shell interpolation):",
      assignment.verificationCommands.map(
        (argv) => `${argv.join(" ")} (argv: ${JSON.stringify(argv)})`,
      ),
    ),
    "",
    ...lines("Allowed Superpowers skills:", profile.allowedSkills),
    "",
    ...lines(
      "Required structured evidence kinds:",
      [
        ...assignment.requiredDisciplines.map(
          (discipline) => `superpower:${discipline}`,
        ),
        ...assignment.verificationCommands.map(
          (argv) => `command:${argv.join(" ")}`,
        ),
      ],
    ),
    "",
    ...profile.instructions,
    "",
    "Completion protocol:",
    `- Write exactly one schemaVersion 1 JSON result to ${resultPath}.`,
    `- Copy assignmentHash exactly as ${assignment.assignmentHash}.`,
    "- Terminal prose, Herdr idle/done state, and an uncommitted working tree are not completion.",
    "- If the spec or architecture is wrong, return outcome=blocked with reason, evidence, and suggestedChange; do not edit planning artifacts.",
  ];
  if (assignment.role === "review") {
    sections.push(
      "- Review only the assigned immutable commit in this detached read-only worktree.",
      "- Do not implement remediation in the review workspace.",
    );
  }
  if (assignment.scope === "final_diff") {
    sections.push(
      `- Final diff base: ${assignment.frozenBase}`,
      `- Final diff reviewed head: ${assignment.runHead}`,
      "- This assignment has no task ID and no writable remediation path.",
    );
  }
  return `${sections.join("\n")}\n`;
}
