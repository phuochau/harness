import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeProcessRunner } from "../git/process.js";

async function checked(
  processRunner: NodeProcessRunner,
  cwd: string,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): Promise<string> {
  const result = await processRunner.run("specify", argv, {
    cwd,
    env,
    shell: false,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}

export async function runSpecKitCompatibilitySmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-speckit-compat-"));
  const config = join(root, "config");
  const project = join(root, "project");
  const env = { XDG_CONFIG_HOME: config };
  const processRunner = new NodeProcessRunner();
  try {
    await checked(processRunner, root, env, [
      "init",
      project,
      "--integration",
      "claude",
      "--ignore-agent-tools",
      "--no-git",
    ]);
    await checked(processRunner, project, env, [
      "preset",
      "add",
      "--dev",
      resolve("presets/harness-task-graph"),
    ]);
    await checked(processRunner, project, env, [
      "preset",
      "resolve",
      "speckit.tasks",
    ]);
    const command = await readFile(
      join(
        project,
        ".specify/presets/harness-task-graph/.composed/speckit.tasks.md",
      ),
      "utf8",
    );
    if (
      !command.includes("harness-task-metadata:v1") ||
      !command.includes("controller derives both deterministically") ||
      command.includes("{CORE_TEMPLATE}")
    ) {
      throw new Error("Spec Kit materialized an incompatible wrapped command");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
