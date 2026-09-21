import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitRepository } from "../../src/git/repository.js";
import { NodeProcessRunner } from "../../src/git/process.js";

export interface TempGitRepository {
  readonly path: string;
  readonly repository: GitRepository;
  readonly initialCommit: string;
  cleanup(): Promise<void>;
}

export async function createTempGitRepository(
  suffix = "repo",
  initialFiles: Readonly<Record<string, string>> = {},
): Promise<TempGitRepository> {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), `pi harness ${suffix}-`)),
  );
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
  for (const [name, contents] of Object.entries(initialFiles)) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), contents, "utf8");
  }
  await run(["add", "."]);
  await run(["commit", "-m", "initial fixture"]);
  const initialCommit = await run(["rev-parse", "HEAD"]);
  return {
    path,
    repository: await GitRepository.open(path, process),
    initialCommit,
    cleanup: async () => rm(path, { recursive: true, force: true }),
  };
}

export interface IntegratedDependenciesFixture extends TempGitRepository {
  readonly integrationHead: string;
}

export async function createTempRepoWithIntegratedDependencies(
  taskIds: readonly string[],
): Promise<IntegratedDependenciesFixture> {
  const fixture = await createTempGitRepository("integrated dependencies");
  const run = await fixture.repository.ensureRunBranch(
    "F023",
    fixture.initialCommit,
  );
  let integrationHead = run.commit;
  for (const taskId of taskIds) {
    integrationHead = await fixture.repository.commitOnBranch(
      run.name,
      `integrate ${taskId}`,
    );
  }
  return { ...fixture, integrationHead };
}
