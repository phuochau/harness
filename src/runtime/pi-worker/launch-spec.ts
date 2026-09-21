import type { ResolvedProfile } from "../../config/profiles.js";
import type { ManagedProfileView } from "../managed/materialize.js";
import type { PiLaunchSpec } from "../pi-process/types.js";

export interface BuildPiLaunchSpecInput {
  readonly attemptId: string;
  readonly attemptToken: string;
  readonly piExecutable: string;
  readonly piExecutableArgs?: readonly string[];
  readonly profile: ResolvedProfile;
  readonly managed: ManagedProfileView;
  readonly transportExtensionPath: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly prompt: string;
}

function appendPaths(
  argv: string[],
  flag: "--extension" | "--skill" | "--prompt-template",
  paths: readonly string[],
): void {
  for (const path of paths) argv.push(flag, path);
}

export function buildPiLaunchSpec(input: BuildPiLaunchSpecInput): PiLaunchSpec {
  const argv = [
    ...(input.piExecutableArgs ?? []),
    "--mode", "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
    "--provider", input.profile.provider,
    "--model", input.profile.model,
  ];
  if (input.profile.thinking !== undefined) {
    argv.push("--thinking", input.profile.thinking);
  }
  if (input.profile.tools.length === 0) argv.push("--no-tools");
  else argv.push("--tools", input.profile.tools.join(","));

  appendPaths(argv, "--extension", [
    input.transportExtensionPath,
    ...input.managed.extensionPaths,
  ]);
  appendPaths(argv, "--skill", input.managed.piSkillPaths);
  appendPaths(argv, "--prompt-template", input.managed.promptTemplatePaths);
  argv.push(
    "--session-id", input.sessionId,
    "--session-dir", input.sessionDir,
    "--",
    input.prompt,
  );
  return {
    attemptId: input.attemptId,
    attemptToken: input.attemptToken,
    executable: input.piExecutable,
    argv,
    cwd: input.cwd,
    env: input.managed.environment,
    sessionId: input.sessionId,
    sessionDir: input.sessionDir,
  };
}

export function buildPiProbePrefix(
  profile: ResolvedProfile,
  managed: ManagedProfileView,
): readonly string[] {
  const argv = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
  ];
  appendPaths(argv, "--extension", managed.extensionPaths);
  return argv;
}
