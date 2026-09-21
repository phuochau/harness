import { realpath } from "node:fs/promises";
import type { ProcessRunner } from "../actions/types.js";
import { NodeProcessRunner } from "./process.js";
import {
  planningBranchName,
  runBranchName,
  taskBranchName,
} from "./branches.js";

export interface BranchRef {
  readonly name: string;
  readonly baseCommit: string;
  readonly commit: string;
}

export interface RepositoryInspection {
  readonly root: string;
  readonly commonDir: string;
  readonly head: string;
  readonly branch: string | null;
  readonly dirty: boolean;
}

export class GitInvariantError extends Error {}

export class GitRepository {
  private constructor(
    public readonly root: string,
    private readonly process: ProcessRunner,
  ) {}

  public static async open(
    root: string,
    process: ProcessRunner = new NodeProcessRunner(),
  ): Promise<GitRepository> {
    return new GitRepository(await realpath(root), process);
  }

  private async git(
    argv: readonly string[],
    options: { stdin?: Uint8Array } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.process.run("git", ["-C", this.root, ...argv], {
      shell: false,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });
  }

  private async checked(argv: readonly string[]): Promise<string> {
    const result = await this.git(argv);
    if (result.exitCode !== 0) {
      throw new GitInvariantError(
        `git ${argv[0] ?? "command"} failed: ${result.stderr.trim()}`,
      );
    }
    return result.stdout.trim();
  }

  public async inspect(): Promise<RepositoryInspection> {
    const [root, commonDir, head, branch, status] = await Promise.all([
      this.checked(["rev-parse", "--show-toplevel"]),
      this.checked(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      this.checked(["rev-parse", "HEAD"]),
      this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.checked(["status", "--porcelain=v1"]),
    ]);
    return {
      root,
      commonDir,
      head,
      branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
      dirty: status.length > 0,
    };
  }

  public async revParse(ref: string): Promise<string> {
    return this.checked(["rev-parse", "--verify", ref]);
  }

  public async revParseOptional(ref: string): Promise<string | undefined> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", ref]);
    if (result.exitCode === 0) return result.stdout.trim();
    return undefined;
  }

  public async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.git([
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitInvariantError(result.stderr);
  }

  private async ensureBranch(
    name: string,
    baseCommit: string,
    expectedHead: string,
  ): Promise<BranchRef> {
    const base = await this.revParse(baseCommit);
    const expected = await this.revParse(expectedHead);
    let existing = await this.revParseOptional(`refs/heads/${name}`);
    if (existing && existing !== expected) {
      throw new GitInvariantError(`${name} has unexpected head ${existing}`);
    }
    if (!existing) {
      const create = await this.git(["branch", name, base]);
      if (create.exitCode !== 0) {
        existing = await this.revParseOptional(`refs/heads/${name}`);
        if (!existing) throw new GitInvariantError(create.stderr);
      }
    }
    const commit = existing ?? base;
    if (!(await this.isAncestor(base, commit))) {
      throw new GitInvariantError(`${name} escaped its recorded base ${base}`);
    }
    return { name, baseCommit: base, commit };
  }

  public ensureRunBranch(
    runId: string,
    base: string,
    expectedHead = base,
  ): Promise<BranchRef> {
    return this.ensureBranch(runBranchName(runId), base, expectedHead);
  }

  public ensurePlanningBranch(
    runId: string,
    base: string,
    expectedHead = base,
  ): Promise<BranchRef> {
    return this.ensureBranch(planningBranchName(runId), base, expectedHead);
  }

  public ensureTaskBranch(
    runId: string,
    taskId: string,
    integrationBase: string,
    expectedHead = integrationBase,
  ): Promise<BranchRef> {
    return this.ensureBranch(
      taskBranchName(runId, taskId),
      integrationBase,
      expectedHead,
    );
  }

  public async mergeBase(left: string, right: string): Promise<string> {
    return this.checked(["merge-base", left, right]);
  }

  public async commitOnBranch(name: string, message: string): Promise<string> {
    const ref = `refs/heads/${name}`;
    const head = await this.revParse(ref);
    const tree = await this.checked(["rev-parse", `${head}^{tree}`]);
    const commit = await this.git([
      "commit-tree",
      tree,
      "-p",
      head,
      "-m",
      message,
    ]);
    if (commit.exitCode !== 0) throw new GitInvariantError(commit.stderr);
    const next = commit.stdout.trim();
    await this.checked(["update-ref", ref, next, head]);
    return next;
  }
}
