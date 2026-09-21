import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempRepo } from "./temp-repo.js";

export interface TempRepoWithWorktree {
  readonly repository: string;
  readonly worktree: string;
  readonly commonDir: string;
  cleanup(): Promise<void>;
}

export async function createTempRepoWithWorktree(): Promise<TempRepoWithWorktree> {
  const repo = await createTempRepo();
  const worktreeParent = await mkdtemp(join(tmpdir(), "pi-harness-linked-"));
  const worktree = join(worktreeParent, "worktree");
  const add = await repo.process.run(
    "git",
    ["worktree", "add", "-b", "fixture-linked", worktree],
    { cwd: repo.path, shell: false },
  );
  if (add.exitCode !== 0) {
    await rm(worktreeParent, { recursive: true, force: true });
    await rm(repo.path, { recursive: true, force: true });
    throw new Error(add.stderr);
  }
  const common = await repo.process.run(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: worktree, shell: false },
  );
  if (common.exitCode !== 0) throw new Error(common.stderr);
  const commonDir = common.stdout.trim();
  return {
    repository: repo.path,
    worktree,
    commonDir,
    cleanup: async () => {
      await repo.process.run("git", ["worktree", "remove", "--force", worktree], {
        cwd: repo.path,
        shell: false,
      });
      await rm(worktreeParent, { recursive: true, force: true });
      await rm(repo.path, { recursive: true, force: true });
    },
  };
}
