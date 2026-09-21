import { parse } from "yaml";
import {
  validateEnvironmentAndLock,
  validateWorkflow,
} from "../contracts/index.js";
import { compileWorkflow } from "../config/compile.js";

interface PiSettingsPackage {
  readonly source: string;
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly themes: readonly string[];
}

function settingsPackages(value: unknown): readonly PiSettingsPackage[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pi settings must be an object");
  }
  const packages = (value as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) throw new Error("Pi settings packages must be an array");
  return packages.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Pi settings package must be an object");
    }
    const candidate = item as Partial<PiSettingsPackage>;
    const keys = Object.keys(item).sort();
    if (
      JSON.stringify(keys) !==
      JSON.stringify(["extensions", "prompts", "skills", "source", "themes"])
    ) {
      throw new Error("Pi settings package contains unknown or missing keys");
    }
    if (
      typeof candidate.source !== "string" ||
      !Array.isArray(candidate.extensions) ||
      !Array.isArray(candidate.skills) ||
      !Array.isArray(candidate.prompts) ||
      !Array.isArray(candidate.themes)
    ) {
      throw new Error("Pi settings package must declare all resource filters");
    }
    for (const filter of [
      ...candidate.extensions,
      ...candidate.skills,
      ...candidate.prompts,
      ...candidate.themes,
    ]) {
      if (typeof filter !== "string" || !filter.startsWith("+")) {
        throw new Error("Pi settings package filters must be exact +path entries");
      }
    }
    return candidate as PiSettingsPackage;
  });
}

export function validateGeneratedConfiguration(files: Readonly<Record<string, string>>): void {
  const workflow = validateWorkflow(parse(files[".harness/workflow.yaml"]!));
  const { environment, lock } = validateEnvironmentAndLock(
    parse(files[".harness/environment.yaml"]!),
    parse(files[".harness/harness.lock"]!),
  );
  compileWorkflow({ workflow, environment });
  for (const [path, contents] of Object.entries(files)) {
    if (!path.startsWith(".harness/workflows/") || !path.endsWith(".yaml")) continue;
    compileWorkflow({ workflow: validateWorkflow(parse(contents)), environment });
  }
  const policy = parse(files[".harness/policy.yaml"]!);
  if (policy?.schema !== "harness/policy/v1") {
    throw new Error("invalid generated harness policy");
  }
  const packages = settingsPackages(JSON.parse(files[".pi/settings.json"]!));
  if (packages.length !== environment.pi_packages.length) {
    throw new Error("Pi settings package set disagrees with the environment");
  }
  if (new Set(packages.map((item) => item.source)).size !== packages.length) {
    throw new Error("Pi settings package sources must be unique");
  }
  for (const requirement of environment.pi_packages) {
    const dependency = lock.dependencies.find(
      (candidate) => candidate.id === requirement.dependency,
    )!;
    const projected = packages.filter((candidate) => candidate.source === dependency.piSource);
    if (projected.length !== 1) {
      throw new Error(`Pi settings do not project package ${requirement.id} exactly once`);
    }
    const settings = projected[0]!;
    for (const type of ["extensions", "skills", "prompts", "themes"] as const) {
      const expected = (requirement.resources[type] ?? []).map((path) => `+${path}`).sort();
      if (JSON.stringify([...settings[type]].sort()) !== JSON.stringify(expected)) {
        throw new Error(`Pi settings ${type} filters disagree for ${requirement.id}`);
      }
    }
  }
}
