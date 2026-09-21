import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeProcessRunner } from "./fake-process.js";

export interface TempRepo {
  readonly path: string;
  readonly process: NodeProcessRunner;
  readonly initialCommit: string;
}

export async function createTempRepo(): Promise<TempRepo> {
  const path = await mkdtemp(join(tmpdir(), "pi-harness-test-"));
  const process = new NodeProcessRunner();
  const run = async (argv: readonly string[]) => {
    const result = await process.run("git", argv, { cwd: path, shell: false });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Harness Tests"]);
  await run(["config", "user.email", "harness@example.invalid"]);
  await writeFile(join(path, "README.md"), "# fixture\n", "utf8");
  await run(["add", "README.md"]);
  await run(["commit", "-m", "initial fixture"]);
  const initialCommit = await run(["rev-parse", "HEAD"]);
  return { path, process, initialCommit };
}
