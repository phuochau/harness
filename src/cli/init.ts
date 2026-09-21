import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  detectCommandsFromManifests,
  type VerificationCommands,
} from "./command-detection.js";
import { validateGeneratedConfiguration } from "./config-merge.js";
import { mergeHarnessIgnore } from "./ignore-merge.js";
import { findPackageRoot } from "./package-root.js";

export interface InitOptions {
  readonly root: string;
  readonly commands?: VerificationCommands;
}

export class InitError extends Error {}

const defaultAssets: Readonly<Record<string, string>> = {
  ".harness/workflow.yaml": "workflow.yaml",
  ".harness/environment.yaml": "environment.yaml",
  ".harness/policy.yaml": "policy.yaml",
  ".harness/harness.lock": "harness.lock",
  ".harness/workflows/spec-kit-codex.yaml": "workflows/spec-kit-codex.yaml",
  ".harness/workflows/spec-kit-devin.yaml": "workflows/spec-kit-devin.yaml",
  ".harness/workflows/mixed-workers.yaml": "workflows/mixed-workers.yaml",
  ".pi/settings.json": "pi-settings.json",
};

function confined(root: string, path: string): string {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new InitError(`generated path escapes project root: ${path}`);
  }
  return target;
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function renderDefaults(
  packageRoot: string,
  commands: VerificationCommands,
): Promise<Record<string, string>> {
  const assetRoot = join(packageRoot, "src/defaults");
  const result: Record<string, string> = {};
  for (const [target, source] of Object.entries(defaultAssets)) {
    let contents = await readFile(join(assetRoot, source), "utf8");
    if (target === ".harness/environment.yaml") {
      contents = contents
        .replace("__TASK_VERIFY__", JSON.stringify(commands.taskVerify))
        .replace("__FULL_VERIFY__", JSON.stringify(commands.fullVerify));
    }
    result[target] = contents;
  }
  return result;
}

async function assertNoExistingTargets(
  root: string,
  targets: readonly string[],
): Promise<void> {
  for (const target of targets) {
    const segments = target.split("/").slice(0, -1);
    let parent = root;
    for (const segment of segments) {
      parent = join(parent, segment);
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink()) {
          throw new InitError(`refusing to write through a symbolic link: ${segment}`);
        }
        if (!info.isDirectory()) {
          throw new InitError(`generated path parent is not a directory: ${segment}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    try {
      await lstat(confined(root, target));
      throw new InitError(`refusing to overwrite configuration that already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function assertCommands(commands: VerificationCommands): void {
  for (const [name, argv] of Object.entries(commands)) {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((part) => typeof part !== "string" || part === "")
    ) {
      throw new InitError(`${name} must be a non-empty argv array`);
    }
  }
}

async function atomicWriteSet(
  root: string,
  files: Readonly<Record<string, string>>,
  previousIgnore: string | undefined,
): Promise<void> {
  const staging = join(root, `.harness-init-${randomUUID()}`);
  const installed: string[] = [];
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    for (const [path, contents] of Object.entries(files)) {
      const staged = confined(staging, path);
      await mkdir(dirname(staged), { recursive: true });
      await writeFile(staged, contents, { encoding: "utf8", mode: 0o600 });
    }
    for (const path of Object.keys(files).sort()) {
      const target = confined(root, path);
      await mkdir(dirname(target), { recursive: true });
      await rename(confined(staging, path), target);
      installed.push(path);
    }
  } catch (error) {
    for (const path of installed.reverse()) {
      const target = confined(root, path);
      if (path === ".gitignore" && previousIgnore !== undefined) {
        await writeFile(target, previousIgnore, "utf8");
      } else {
        await rm(target, { force: true });
      }
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function initProject(options: InitOptions): Promise<void> {
  let root: string;
  try {
    root = await realpath(options.root);
  } catch (error) {
    throw new InitError(
      `project path is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let commands: VerificationCommands;
  try {
    commands = options.commands ?? (await detectCommandsFromManifests(root));
  } catch (error) {
    throw new InitError(error instanceof Error ? error.message : String(error));
  }
  assertCommands(commands);
  const packageRoot = await findPackageRoot(import.meta.url, "pi-multi-agent-harness");
  const generated = await renderDefaults(packageRoot, commands);
  await assertNoExistingTargets(root, Object.keys(generated));
  try {
    validateGeneratedConfiguration(generated);
  } catch (error) {
    throw new InitError(
      `generated configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ignorePath = join(root, ".gitignore");
  try {
    if ((await lstat(ignorePath)).isSymbolicLink()) {
      throw new InitError("refusing to replace a symbolic-link .gitignore");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const previousIgnore = await optionalText(ignorePath);
  const files = {
    ...generated,
    ".gitignore": mergeHarnessIgnore(previousIgnore ?? ""),
  };
  await atomicWriteSet(root, files, previousIgnore);
}
