import { spawn } from "node:child_process";
import type { ResolvedProfile } from "../config/profiles.js";

export interface ProfileAuthCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function authCommand(input: {
  readonly profile: ResolvedProfile;
  readonly managedEnvironment: Readonly<Record<string, string>>;
  readonly piExecutable: string;
  readonly devinExecutable?: string;
  readonly claudeExecutable?: string;
}): ProfileAuthCommand {
  const { profile } = input;
  if (profile.family === "codex") {
    return {
      executable: input.piExecutable,
      argv: [
        "--no-extensions", "--no-skills", "--no-prompt-templates",
        "--no-context-files", "--no-themes", "--no-approve",
        "--provider", profile.provider,
        "--model", profile.model,
        "--",
        "Run /login to authenticate this isolated harness profile, then /exit.",
      ],
      env: input.managedEnvironment,
    };
  }
  if (profile.family === "devin") {
    return {
      executable: input.devinExecutable ?? "devin",
      argv: ["auth", "login"],
      env: input.managedEnvironment,
    };
  }
  return {
    executable: input.claudeExecutable ?? "claude",
    argv: ["auth", "login", "--claudeai"],
    env: input.managedEnvironment,
  };
}

export function runInteractive(command: ProfileAuthCommand, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.argv], {
      cwd,
      env: { ...command.env },
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`interactive command terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}
