import { NodeProcessRunner } from "../../git/process.js";
import type { EvidenceGit } from "../../core/evidence.js";

export class GitEvidence implements EvidenceGit {
  private readonly process = new NodeProcessRunner();

  public constructor(private readonly repositoryRoot: string) {}

  private async checked(cwd: string, argv: readonly string[]): Promise<string> {
    const result = await this.process.run("git", argv, { cwd, shell: false });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim());
    return result.stdout.trim();
  }

  public async changedPaths(base: string, head: string): Promise<readonly string[]> {
    const output = await this.checked(this.repositoryRoot, [
      "diff", "--name-only", "--no-renames", base, head,
    ]);
    return output === "" ? [] : output.split("\n").sort();
  }

  public async worktreeStatus(path: string): Promise<readonly string[]> {
    const output = await this.checked(path, [
      "status", "--porcelain=v1", "--untracked-files=all",
    ]);
    return output === "" ? [] : output.split("\n");
  }

  public worktreeCommit(path: string): Promise<string> {
    return this.checked(path, ["rev-parse", "HEAD"]);
  }
}
