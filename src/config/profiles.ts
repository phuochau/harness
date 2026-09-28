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
import { validateProfileIntegration } from "../providers/identity.js";

export interface ResolvedProfileSkill {
  readonly id: string;
  readonly path: string;
  readonly targets: readonly SkillTarget[];
}

export interface ResolvedProfileModelConfig {
  readonly baseUrl: string;
  readonly api: "openai-completions";
  readonly name?: string;
  readonly apiKeyEnv?: string;
}

export interface ResolvedProfile {
  readonly id: string;
  readonly family: ProfileFamily;
  readonly integration?: string;
  readonly runtime: "pi";
  readonly provider: string;
  readonly model: string;
  readonly modelConfig?: ResolvedProfileModelConfig;
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
  readonly extensions: Readonly<Record<string, string | readonly string[]>>;
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

function loopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

type ProfileModelConfigDeclaration = NonNullable<
  ProfileDocument["profiles"][string]["model_config"]
>;

function resolveModelConfig(
  id: string,
  config: ProfileModelConfigDeclaration,
): ResolvedProfileModelConfig {
  let url: URL;
  try {
    url = new URL(config.base_url);
  } catch {
    throw new Error(`profile ${id}: model_config base_url is not a valid URL`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`profile ${id}: model_config base_url must not embed userinfo`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      `profile ${id}: model_config base_url must not include a query or fragment`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`profile ${id}: model_config base_url must use http or https`);
  }
  const loopback = loopbackHostname(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error(
      `profile ${id}: model_config base_url must be a loopback endpoint for http`,
    );
  }
  if (!loopback && config.api_key_env === undefined) {
    throw new Error(
      `profile ${id}: model_config base_url is remote and requires api_key_env`,
    );
  }
  return {
    baseUrl: config.base_url,
    api: config.api,
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.api_key_env === undefined ? {} : { apiKeyEnv: config.api_key_env }),
  };
}

function resolveResource<T>(
  id: string,
  kind: string,
  resources: Readonly<Record<string, T>>,
): T {
  const path = resources[id];
  if (path === undefined) throw new Error(`${id} has no locked ${kind} resource`);
  return path;
}

export function resolveProfiles(
  input: ProfileDocument,
  resources: LockedProfileResources,
): ResolvedProfiles {
  const document = validateProfiles(structuredClone(input));
  const byId: Record<string, ResolvedProfile> = {};

  for (const id of Object.keys(document.profiles).sort()) {
    const profile = document.profiles[id]!;
    validateProfileIntegration({ id, ...profile });
    const modelConfig =
      profile.model_config === undefined
        ? undefined
        : resolveModelConfig(id, profile.model_config);
    const skillIds = new Set<string>();
    const skills = [...profile.skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) => {
        if (skillIds.has(skill.id)) throw new Error(`duplicate skill ${skill.id}`);
        skillIds.add(skill.id);
        const targets = sortedUnique(skill.targets, `target for ${skill.id}`) as SkillTarget[];
        return {
          id: skill.id,
          path: resolveResource(skill.id, "skill", resources.skills),
          targets,
        };
      });
    const normalized = {
      id,
      family: profile.family,
      ...(profile.integration === undefined ? {} : { integration: profile.integration }),
      runtime: profile.runtime,
      provider: profile.provider,
      model: profile.model,
      ...(modelConfig === undefined ? {} : { modelConfig }),
      ...(profile.thinking === undefined ? {} : { thinking: profile.thinking }),
      role: profile.role,
      environment: profile.environment,
      tools: sortedUnique(profile.tools, `tool in ${id}`),
      extensions: sortedUnique(profile.extensions, `extension in ${id}`).flatMap((resourceId) => {
        const declared = resolveResource(resourceId, "extension", resources.extensions);
        return typeof declared === "string" ? [declared] : [...declared];
      }),
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
