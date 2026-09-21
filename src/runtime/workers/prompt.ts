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
    `- Copy assignmentHash exactly as ${assignment.assignmentHash}.`,
    "- If the spec or architecture is wrong, return outcome=blocked with reason, evidence, and suggestedChange; do not edit planning artifacts.",
  ];
  if (assignment.role === "implementation") {
    sections.push(
      `- Write exactly one schemaVersion 1 JSON result to ${resultPath}.`,
      "- Every evidence item is {kind,path,sha256}; path must be a regular file below .harness-output and sha256 must equal the file bytes.",
      "- Keep .harness-output untracked. Never commit evidence artifacts.",
      "- Terminal prose, Herdr idle/done state, and an uncommitted working tree are not completion.",
      "- Commit the implementation before reporting completion and leave no changes outside .harness-output.",
      `- Completed result shape: {"schemaVersion":1,"assignmentHash":"${assignment.assignmentHash}","role":"implementation","outcome":"completed","commit":"<git HEAD>","evidence":[{"kind":"<required kind>","path":".harness-output/<file>","sha256":"sha256:<64 lowercase hex>"}]}.`,
    );
  }
  if (assignment.role === "review") {
    sections.push(
      "- Do not write files. The harness materializes your evidence outside the read-only agent session.",
      "- End your final response with exactly two protocol lines: an unwrapped line beginning `HARNESS_REVIEW_RESULT_V1 ` followed by compact JSON, then `HARNESS_REVIEW_RESULT_END_V1` on its own line.",
      "- The envelope is {result,evidence}; result omits its evidence field, while evidence is an array of {kind,content} with one item for every required structured evidence kind.",
      "- No terminal status or prose counts as completion without a valid matching marker line.",
      "- Review only the assigned immutable commit in this detached read-only worktree.",
      "- Do not implement remediation in the review workspace.",
      `- Approved marker example: HARNESS_REVIEW_RESULT_V1 {"result":{"schemaVersion":1,"assignmentHash":"${assignment.assignmentHash}","role":"review","outcome":"approved","reviewedCommit":"${assignment.commit}","findings":[]},"evidence":[{"kind":"<required kind>","content":"commands and observations supporting the review"}]}`,
      `- Changes-requested uses the same envelope with outcome="changes_requested", reviewedCommit="${assignment.commit}", and at least one finding.`,
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
