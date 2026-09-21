import type { ResolvedProfile } from "../../config/profiles.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import type { ManagedRuntimePaths } from "./paths.js";

export interface ManagedEnvironmentInput {
  readonly profile: ResolvedProfile;
  readonly paths: ManagedRuntimePaths;
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly forwardedKeys: readonly string[];
  readonly executablePath: string;
}

const reserved = new Set([
  "HOME",
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

function optionalAmbient(
  ambient: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: string,
): string {
  return ambient[key] ?? fallback;
}

export function buildManagedEnvironment(
  input: ManagedEnvironmentInput,
): Readonly<Record<string, string>> {
  if (input.profile.id === "" || input.executablePath === "") {
    throw new Error("managed environment requires a profile and executable PATH");
  }
  const environment: Record<string, string> = {
    HOME: input.paths.profileHome,
    PI_CODING_AGENT_DIR: input.paths.piAgentDir,
    XDG_CONFIG_HOME: input.paths.xdgConfigHome,
    XDG_DATA_HOME: input.paths.xdgDataHome,
    PATH: input.executablePath,
    LANG: optionalAmbient(input.ambient, "LANG", "C.UTF-8"),
    LC_ALL: optionalAmbient(input.ambient, "LC_ALL", "C.UTF-8"),
    TERM: optionalAmbient(input.ambient, "TERM", "dumb"),
  };
  const seen = new Set<string>();
  for (const key of input.forwardedKeys) {
    if (seen.has(key)) throw new Error(`duplicate forwarded environment key ${key}`);
    seen.add(key);
    if (reserved.has(key)) throw new Error(`reserved environment key cannot be forwarded: ${key}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid forwarded environment key ${key}`);
    }
    const value = input.ambient[key];
    if (value !== undefined) environment[key] = value;
  }
  return deepFreeze(environment);
}
