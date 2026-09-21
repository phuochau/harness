import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface VerificationCommands {
  readonly taskVerify: readonly string[];
  readonly fullVerify: readonly string[];
}

export class CommandDetectionError extends Error {}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function nodeCommands(text: string): VerificationCommands | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CommandDetectionError("package.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return undefined;
  const values = scripts as Record<string, unknown>;
  if (typeof values.test !== "string" || values.test.trim() === "") return undefined;
  return {
    taskVerify: ["npm", "test"],
    fullVerify:
      typeof values.verify === "string" && values.verify.trim() !== ""
        ? ["npm", "run", "verify"]
        : ["npm", "test"],
  };
}

function pythonCommands(text: string): VerificationCommands | undefined {
  if (!/^\s*\[tool\.pytest(?:\.|\])/m.test(text) && !/\bpytest\b/.test(text)) {
    return undefined;
  }
  return {
    taskVerify: ["python", "-m", "pytest"],
    fullVerify: ["python", "-m", "pytest"],
  };
}

export async function detectCommandsFromManifests(
  root: string,
): Promise<VerificationCommands> {
  const [packageText, pyprojectText] = await Promise.all([
    optionalText(join(root, "package.json")),
    optionalText(join(root, "pyproject.toml")),
  ]);
  const candidates = [
    ...(packageText === undefined ? [] : [nodeCommands(packageText)]),
    ...(pyprojectText === undefined ? [] : [pythonCommands(pyprojectText)]),
  ].filter((candidate): candidate is VerificationCommands => candidate !== undefined);
  if (candidates.length !== 1) {
    throw new CommandDetectionError(
      "could not choose verification commands; pass --task-verify and --full-verify as JSON argv arrays",
    );
  }
  return candidates[0]!;
}

export function parseArgvJson(value: string, flag: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CommandDetectionError(`${flag} must be a JSON argv array`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== "string" || item === "")
  ) {
    throw new CommandDetectionError(`${flag} must be a non-empty JSON string array`);
  }
  return parsed;
}
