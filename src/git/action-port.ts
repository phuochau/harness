import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitPort,
  SealedImplementation,
} from "../actions/types.js";
import { sha256 } from "../shared/sha256.js";
import { NodeProcessRunner } from "./process.js";

export interface IntegrationIdentity {
  readonly effectKey: string;
  readonly expectedRunHead: string;
  readonly change: SealedImplementation;
}

export class NativeGitInvariantError extends Error {}

function trailerMap(message: string): ReadonlyMap<string, string> {
  const trailers = new Map<string, string>();
  for (const line of message.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9-]*): (.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      trailers.set(match[1], match[2]);
    }
  }
  return trailers;
}

export class NativeGitActionPort implements GitPort {
  private readonly process = new NodeProcessRunner();

  public constructor(public readonly root: string) {}

  private async run(
    argv: readonly string[],
    options: { cwd?: string; stdin?: Uint8Array; env?: Readonly<Record<string, string>> } = {},
  ) {
    return this.process.run("git", argv, {
      shell: false,
      ...(options.cwd === undefined ? { cwd: this.root } : { cwd: options.cwd }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  private async checked(
    argv: readonly string[],
    options: { cwd?: string; stdin?: Uint8Array; env?: Readonly<Record<string, string>> } = {},
  ): Promise<string> {
    const result = await this.run(argv, options);
    if (result.exitCode !== 0) {
      throw new NativeGitInvariantError(
        `git ${argv[0] ?? "command"} failed: ${result.stderr.trim()}`,
      );
    }
    return result.stdout.trim();
  }

  public async patchIdForRange(base: string, head: string): Promise<string> {
    const result = await this.process.runBytes(
      "git",
      ["diff", "--binary", "--full-index", base, head],
      { cwd: this.root, shell: false },
    );
    if (result.exitCode !== 0) throw new NativeGitInvariantError(result.stderr);
    return sha256(result.stdout);
  }

  public async revParse(ref: string): Promise<string> {
    return this.checked(["rev-parse", "--verify", ref]);
  }

  public async revParseOptional(ref: string): Promise<string | undefined> {
    const result = await this.run(["rev-parse", "--verify", "--quiet", ref]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  public async status(path: string): Promise<readonly string[]> {
    const output = await this.checked(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: path },
    );
    return output === "" ? [] : output.split("\n");
  }

  public async assertWorktreeCommit(path: string, expectedCommit: string): Promise<void> {
    const head = await this.checked(["rev-parse", "HEAD"], { cwd: path });
    const expected = await this.revParse(expectedCommit);
    if (head !== expected) {
      throw new NativeGitInvariantError(`expected ${expected}, observed ${head}`);
    }
  }

  public async findCommitByTrailer(
    branch: string,
    key: string,
    value: string,
  ): Promise<string | undefined> {
    const result = await this.run(["log", branch, "--format=%H%x00%B%x00"]);
    if (result.exitCode !== 0) return undefined;
    const fields = result.stdout.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const commit = fields[index]?.trim();
      const message = fields[index + 1] ?? "";
      if (commit && trailerMap(message).get(key) === value) return commit;
    }
    return undefined;
  }

  public async commitTree(
    tree: string,
    input: { parent: string; trailers: Readonly<Record<string, string>> },
  ): Promise<string> {
    const trailerText = Object.entries(input.trailers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    return this.checked([
      "commit-tree",
      tree,
      "-p",
      input.parent,
      "-m",
      `Harness managed commit\n\n${trailerText}`,
    ]);
  }

  public async updateRefCas(
    ref: string,
    next: string,
    expected: string,
  ): Promise<void> {
    const resolvedRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    const result = await this.run(["update-ref", resolvedRef, next, expected]);
    if (result.exitCode !== 0) {
      throw new NativeGitInvariantError(
        `stale run head or ref identity for ${resolvedRef}: ${result.stderr.trim()}`,
      );
    }
  }

  public async readTextAt(commit: string, path: string): Promise<string> {
    const result = await this.process.runBytes(
      "git",
      ["show", `${commit}:${path}`],
      { cwd: this.root, shell: false },
    );
    if (result.exitCode !== 0) {
      throw new NativeGitInvariantError(`cannot read ${path} at ${commit}`);
    }
    return new TextDecoder("utf8", { fatal: true }).decode(result.stdout);
  }

  public async treeContains(commit: string, paths: readonly string[]): Promise<boolean> {
    const output = await this.checked(["ls-tree", "-r", "--name-only", commit]);
    const present = new Set(output.split("\n").filter(Boolean));
    return paths.every((path) => present.has(path));
  }

  public async commitParents(commit: string): Promise<readonly string[]> {
    const output = await this.checked(["show", "-s", "--format=%P", commit]);
    return output === "" ? [] : output.split(" ");
  }

  public async commitTrailers(commit: string): Promise<ReadonlyMap<string, string>> {
    return trailerMap(await this.checked(["show", "-s", "--format=%B", commit]));
  }

  public async treeOf(commit: string): Promise<string> {
    return this.revParse(`${commit}^{tree}`);
  }

  private async withDetachedTree(
    commit: string,
    operation: (path: string) => Promise<string>,
  ): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), "pi harness candidate "));
    const path = join(parent, "worktree");
    const add = await this.run(["worktree", "add", "--detach", path, commit]);
    if (add.exitCode !== 0) {
      await rm(parent, { recursive: true, force: true });
      throw new NativeGitInvariantError(add.stderr.trim());
    }
    try {
      return await operation(path);
    } finally {
      await this.run(["worktree", "remove", "--force", path]);
      await rm(parent, { recursive: true, force: true });
    }
  }

  private async applyRangeToTree(identity: IntegrationIdentity): Promise<string> {
    const diff = await this.process.runBytes(
      "git",
      [
        "diff",
        "--binary",
        "--full-index",
        identity.change.baseCommit,
        identity.change.headCommit,
      ],
      { cwd: this.root, shell: false },
    );
    if (diff.exitCode !== 0) throw new NativeGitInvariantError(diff.stderr);
    return this.withDetachedTree(identity.expectedRunHead, async (path) => {
      const apply = await this.run(["apply", "--index", "--binary", "-"], {
        cwd: path,
        stdin: diff.stdout,
      });
      if (apply.exitCode !== 0) {
        throw new NativeGitInvariantError(
          `integration conflict: ${apply.stderr.trim() || "patch did not apply"}`,
        );
      }
      return this.checked(["write-tree"], { cwd: path });
    });
  }

  public async createIntegrationCandidate(
    candidateRef: string,
    identity: IntegrationIdentity,
  ): Promise<string> {
    const actualPatchId = await this.patchIdForRange(
      identity.change.baseCommit,
      identity.change.headCommit,
    );
    if (actualPatchId !== identity.change.patchId) {
      throw new NativeGitInvariantError("sealed patch identity changed");
    }
    const sourceTree = await this.treeOf(identity.change.headCommit);
    if (sourceTree !== identity.change.sourceTree) {
      throw new NativeGitInvariantError("sealed source tree identity changed");
    }
    const tree = await this.applyRangeToTree(identity);
    const commit = await this.commitTree(tree, {
      parent: identity.expectedRunHead,
      trailers: {
        "Harness-Effect-Key": identity.effectKey,
        "Harness-Expected-Run-Head": identity.expectedRunHead,
        "Harness-Patch-ID": identity.change.patchId,
        "Harness-Source-Base": identity.change.baseCommit,
        "Harness-Source-Head": identity.change.headCommit,
        "Harness-Source-Tree": identity.change.sourceTree,
      },
    });
    await this.updateRefCas(candidateRef, commit, "0".repeat(40));
    return commit;
  }

  public async assertIntegrationMetadata(
    commit: string,
    identity: IntegrationIdentity,
  ): Promise<void> {
    const parents = await this.commitParents(commit);
    if (parents.length !== 1 || parents[0] !== identity.expectedRunHead) {
      throw new NativeGitInvariantError("candidate parent is not expected run head");
    }
    const expected: Readonly<Record<string, string>> = {
      "Harness-Effect-Key": identity.effectKey,
      "Harness-Expected-Run-Head": identity.expectedRunHead,
      "Harness-Patch-ID": identity.change.patchId,
      "Harness-Source-Base": identity.change.baseCommit,
      "Harness-Source-Head": identity.change.headCommit,
      "Harness-Source-Tree": identity.change.sourceTree,
    };
    const trailers = await this.commitTrailers(commit);
    for (const [key, value] of Object.entries(expected)) {
      if (trailers.get(key) !== value) {
        throw new NativeGitInvariantError(`candidate trailer mismatch: ${key}`);
      }
    }
    const expectedTree = await this.applyRangeToTree(identity);
    if ((await this.treeOf(commit)) !== expectedTree) {
      throw new NativeGitInvariantError("candidate tree does not match sealed change");
    }
  }

  public async buildTreeWithTextFile(
    commit: string,
    path: string,
    contents: string,
  ): Promise<string> {
    if (
      path === "" ||
      path.startsWith("/") ||
      path.split("/").some((segment) => segment === ".." || segment === ".")
    ) {
      throw new NativeGitInvariantError(`invalid repository-relative path: ${path}`);
    }
    const directory = await mkdtemp(join(tmpdir(), "pi harness index "));
    const indexPath = join(directory, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      await this.checked(["read-tree", `${commit}^{tree}`], { env });
      const blob = await this.checked(["hash-object", "-w", "--stdin"], {
        stdin: new TextEncoder().encode(contents),
      });
      await this.checked(
        ["update-index", "--add", "--cacheinfo", "100644", blob, path],
        { env },
      );
      return await this.checked(["write-tree"], { env });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
