import {
  validateProfiles,
  type ProfileDocument,
  type ProfileFamily,
  type ProfileRole,
  type SkillTarget,
} from "../contracts/profiles.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { sha256 } from "../shared/sha256.js";

export interface ResolvedProfileSkill {
  readonly id: string;
  readonly path: string;
  readonly targets: readonly SkillTarget[];
}

export interface ResolvedProfile {
  readonly id: string;
  readonly family: ProfileFamily;
  readonly runtime: "pi";
  readonly provider: string;
  readonly model: string;
  readonly thinking?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  readonly role: ProfileRole;
  readonly environment: "isolated";
  readonly tools: readonly string[];
  readonly extensions: readonly string[];
  readonly skills: readonly ResolvedProfileSkill[];
  readonly promptTemplates: readonly string[];
  readonly contextFiles: false;
  readonly mcp: readonly string[];
  readonly hash: `sha256:${string}`;
}

export interface LockedProfileResources {
  readonly extensions: Readonly<Record<string, string>>;
  readonly skills: Readonly<Record<string, string>>;
  readonly promptTemplates: Readonly<Record<string, string>>;
  readonly mcp: Readonly<Record<string, string>>;
}

export interface ResolvedProfiles {
  readonly byId: Readonly<Record<string, ResolvedProfile>>;
  readonly hash: `sha256:${string}`;
}

function sortedUnique(values: readonly string[], label: string): string[] {
  const unique = new Set(values);
  if (unique.size !== values.length) throw new Error(`duplicate ${label}`);
  return [...unique].sort();
}

function resolveResource(
  id: string,
  kind: string,
  resources: Readonly<Record<string, string>>,
): string {
  const path = resources[id];
  if (path === undefined) throw new Error(`${id} has no locked ${kind} resource`);
  return path;
}

function supportsProviderSkills(family: ProfileFamily): boolean {
  return family === "devin" || family === "claude";
}

export function resolveProfiles(
  input: ProfileDocument,
  resources: LockedProfileResources,
): ResolvedProfiles {
  const document = validateProfiles(structuredClone(input));
  const byId: Record<string, ResolvedProfile> = {};

  for (const id of Object.keys(document.profiles).sort()) {
    const profile = document.profiles[id]!;
    const skillIds = new Set<string>();
    const skills = [...profile.skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) => {
        if (skillIds.has(skill.id)) throw new Error(`duplicate skill ${skill.id}`);
        skillIds.add(skill.id);
        const targets = sortedUnique(skill.targets, `target for ${skill.id}`) as SkillTarget[];
        if (targets.includes("provider") && !supportsProviderSkills(profile.family)) {
          throw new Error(
            `provider skill projection is unsupported for ${profile.family}`,
          );
        }
        return {
          id: skill.id,
          path: resolveResource(skill.id, "skill", resources.skills),
          targets,
        };
      });
    const normalized = {
      id,
      family: profile.family,
      runtime: profile.runtime,
      provider: profile.provider,
      model: profile.model,
      ...(profile.thinking === undefined ? {} : { thinking: profile.thinking }),
      role: profile.role,
      environment: profile.environment,
      tools: sortedUnique(profile.tools, `tool in ${id}`),
      extensions: sortedUnique(profile.extensions, `extension in ${id}`).map(
        (resourceId) =>
          resolveResource(resourceId, "extension", resources.extensions),
      ),
      skills,
      promptTemplates: sortedUnique(
        profile.prompt_templates,
        `prompt template in ${id}`,
      ).map((resourceId) =>
        resolveResource(resourceId, "prompt template", resources.promptTemplates),
      ),
      contextFiles: profile.context_files,
      mcp: sortedUnique(profile.mcp, `MCP resource in ${id}`).map((resourceId) =>
        resolveResource(resourceId, "MCP", resources.mcp),
      ),
    };
    byId[id] = deepFreeze({
      ...normalized,
      hash: sha256(canonicalJson(normalized)),
    });
  }

  return deepFreeze({ byId, hash: sha256(canonicalJson(byId)) });
}
