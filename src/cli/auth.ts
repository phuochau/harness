import { spawn } from "node:child_process";
import { providerIntegration } from "../providers/registry.js";
import type { AuthInput, ProfileAuthCommand } from "../providers/types.js";
export type { ProfileAuthCommand } from "../providers/types.js";

export function authCommand(input: AuthInput): ProfileAuthCommand {
  return providerIntegration(input.profile).authCommand(input);
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
