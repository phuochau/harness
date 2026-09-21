import type { WorkerAssignment } from "../../core/assignment.js";

export interface SuperpowersProfile {
  readonly requiredSkills: readonly string[];
  readonly allowedSkills: readonly string[];
  readonly instructions: readonly string[];
}

const skillAliases: Readonly<Record<string, string>> = {
  "test-driven-development": "superpowers:test-driven-development",
  "systematic-debugging": "superpowers:systematic-debugging",
  "verification-before-completion": "superpowers:verification-before-completion",
  "requesting-code-review": "superpowers:requesting-code-review",
  "receiving-code-review": "superpowers:receiving-code-review",
};

function qualifiedSkill(name: string): string {
  return skillAliases[name] ?? (name.startsWith("superpowers:") ? name : `superpowers:${name}`);
}

export function superpowersProfile(
  assignment: WorkerAssignment,
): SuperpowersProfile {
  const requiredSkills = [...new Set(assignment.requiredDisciplines.map(qualifiedSkill))];
  const defaults = assignment.role === "implementation"
    ? [
        "superpowers:test-driven-development",
        "superpowers:systematic-debugging",
        "superpowers:verification-before-completion",
      ]
    : ["superpowers:requesting-code-review", "superpowers:verification-before-completion"];
  const allowedSkills = [...new Set([...defaults, ...requiredSkills])].sort();
  return Object.freeze({
    requiredSkills: requiredSkills.sort(),
    allowedSkills,
    instructions: [
      "Use Superpowers only inside this worker attempt.",
      "Do not dispatch or orchestrate other workers.",
      "Record evidence for every required discipline in the structured result.",
    ],
  });
}

