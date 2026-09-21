import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SealedImplementation } from "../actions/types.js";
import { sha256 } from "../shared/sha256.js";
import { GitRepository } from "./repository.js";
import { NodeProcessRunner } from "./process.js";
import {
  assertPathInside,
  canonicalExistingPath,
  LifecycleWorktreeBinding,
  makeReviewTreeReadOnly,
  makeTreeOwnerWritable,
  RegistryEntry,
  WorkspaceRole,
  WorktreeRegistry,
  workspacePath,
} from "./worktrees.js";

export class WorkspaceInvariantError extends Error {}

export interface PlanningWorkspaceInput {
  readonly runId: string;
  readonly runBranch: string;
  readonly artifactPaths: readonly string[];
}

export interface ImplementationWorkspaceInput {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly branch: string;
  readonly baseCommit: string;
  readonly ownedPaths: readonly string[];
}

export interface ReviewWorkspaceInput {
  readonly runId: string;
  readonly taskId?: string;
  readonly attempt: number;
  readonly commit: string;
}

export interface VerificationWorkspaceInput {
  readonly runId: string;
  readonly taskId?: string;
  readonly attempt: number;
  readonly commit: string;
}

export interface SealedPlanningArtifacts {
  readonly commit: string;
  readonly hashes: Readonly<Record<string, string>>;
}

interface OpenOptions {
  readonly repository: GitRepository;
  readonly workspaceRoot: string;
}

function normalizeStatus(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((path) => path !== ".harness-output" && !path.startsWith(".harness-output/"));
}

function matchesOwnedPath(path: string, pattern: string): boolean {
  if (pattern === "**" || pattern === "*") return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3).replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (!pattern.includes("*")) return path === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const expression = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${expression}$`).test(path);
}

export class WorktreeLifecycle {
  private readonly process = new NodeProcessRunner();

  private constructor(
    private readonly repository: GitRepository,
    private readonly workspaceRoot: string,
    private readonly registry: WorktreeRegistry,
  ) {}

  public static async open(options: OpenOptions): Promise<WorktreeLifecycle> {
    await mkdir(options.workspaceRoot, { recursive: true });
    const root = await canonicalExistingPath(options.workspaceRoot);
    let entries: readonly RegistryEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(root, "registry.json"), "utf8"),
      );
      if (!Array.isArray(parsed)) throw new Error("registry is not an array");
      entries = parsed as readonly RegistryEntry[];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new WorkspaceInvariantError(`invalid worktree registry: ${String(error)}`);
      }
    }
    return new WorktreeLifecycle(
      options.repository,
      root,
      new WorktreeRegistry(entries),
    );
  }

  private async persistRegistry(): Promise<void> {
    const path = join(this.workspaceRoot, "registry.json");
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.registry.list(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  private async gitAt(
    cwd: string,
    argv: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.process.run("git", argv, { cwd, shell: false });
  }

  private async checkedAt(cwd: string, argv: readonly string[]): Promise<string> {
    const result = await this.gitAt(cwd, argv);
    if (result.exitCode !== 0) {
      throw new WorkspaceInvariantError(
        `git ${argv[0] ?? "command"} failed: ${result.stderr.trim()}`,
      );
    }
    return result.stdout.trim();
  }

  private async addWorktree(
    input: {
      runId: string;
      role: WorkspaceRole;
      taskId?: string;
      attempt?: number;
      branch: string | null;
      commit: string;
      baseCommit: string;
      writable: boolean;
      ownedPaths?: readonly string[];
      artifactPaths?: readonly string[];
    },
  ): Promise<LifecycleWorktreeBinding> {
    const path = workspacePath(this.workspaceRoot, input);
    assertPathInside(this.workspaceRoot, path);
    const registered = this.registry.get(path);
    if (registered !== undefined) {
      const binding = registered.binding;
      if (
        binding.runId !== input.runId ||
        binding.role !== input.role ||
        binding.taskId !== input.taskId ||
        binding.attempt !== input.attempt ||
        binding.branch !== input.branch ||
        binding.baseCommit !== input.baseCommit ||
        binding.writable !== input.writable ||
        JSON.stringify(binding.ownedPaths) !== JSON.stringify(input.ownedPaths ?? []) ||
        JSON.stringify(binding.artifactPaths) !== JSON.stringify(input.artifactPaths ?? [])
      ) {
        throw new WorkspaceInvariantError("registered worktree binding mismatch");
      }
      await this.assertRegisteredIdentity(binding);
      return binding;
    }
    await mkdir(dirname(path), { recursive: true });
    const args = input.branch === null
      ? ["worktree", "add", "--detach", path, input.commit]
      : ["worktree", "add", path, input.branch];
    const result = await this.gitAt(this.repository.root, args);
    if (result.exitCode !== 0) {
      throw new WorkspaceInvariantError(result.stderr.trim());
    }
    const canonicalPath = await canonicalExistingPath(path);
    const binding: LifecycleWorktreeBinding = {
      id: `${input.runId}:${input.role}:${input.taskId ?? "run"}:${input.attempt ?? 0}`,
      runId: input.runId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      role: input.role,
      path: canonicalPath,
      branch: input.branch,
      commit: await this.checkedAt(canonicalPath, ["rev-parse", "HEAD"]),
      baseCommit: input.baseCommit,
      writable: input.writable,
      ownedPaths: [...(input.ownedPaths ?? [])],
      artifactPaths: [...(input.artifactPaths ?? [])],
    };
    this.registry.add(binding);
    if (!input.writable) await makeReviewTreeReadOnly(canonicalPath);
    await this.persistRegistry();
    return binding;
  }

  public async openPlanning(
    input: PlanningWorkspaceInput,
  ): Promise<LifecycleWorktreeBinding> {
    const commit = await this.repository.revParse(input.runBranch);
    return this.addWorktree({
      ...input,
      role: "planning",
      branch: input.runBranch,
      commit,
      baseCommit: commit,
      writable: true,
    });
  }

  public async openImplementation(
    input: ImplementationWorkspaceInput,
  ): Promise<LifecycleWorktreeBinding> {
    return this.addWorktree({
      ...input,
      role: "implementation",
      commit: input.baseCommit,
      writable: true,
    });
  }

  public async openRemediation(
    input: ImplementationWorkspaceInput,
  ): Promise<LifecycleWorktreeBinding> {
    return this.addWorktree({
      ...input,
      role: "remediation",
      commit: input.baseCommit,
      writable: true,
    });
  }

  public async openReview(
    input: ReviewWorkspaceInput,
  ): Promise<LifecycleWorktreeBinding> {
    if (
      this.registry.hasActive("implementation", input.taskId) ||
      this.registry.hasActive("remediation", input.taskId)
    ) {
      throw new WorkspaceInvariantError("implementation workspace active");
    }
    return this.addWorktree({
      ...input,
      role: "review",
      branch: null,
      baseCommit: input.commit,
      writable: false,
    });
  }

  public async openVerification(
    input: VerificationWorkspaceInput,
  ): Promise<LifecycleWorktreeBinding> {
    return this.addWorktree({
      ...input,
      role: "verification",
      branch: null,
      baseCommit: input.commit,
      writable: false,
    });
  }

  public async hashFiles(
    root: string,
    paths: readonly string[],
  ): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    for (const path of [...paths].sort()) {
      if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new WorkspaceInvariantError(`artifact path escapes workspace: ${path}`);
      }
      result[path] = sha256(await readFile(join(root, path)));
    }
    return result;
  }

  public async sealPlanningArtifacts(
    binding: LifecycleWorktreeBinding,
    expectedHashes: Readonly<Record<string, string>>,
  ): Promise<SealedPlanningArtifacts> {
    if (binding.role !== "planning") {
      throw new WorkspaceInvariantError("workspace is not owned by planning");
    }
    const declared = [...binding.artifactPaths].sort();
    if (JSON.stringify(declared) !== JSON.stringify(Object.keys(expectedHashes).sort())) {
      throw new WorkspaceInvariantError("planning artifact set does not match declaration");
    }
    const status = normalizeStatus(
      await this.checkedAt(binding.path, ["status", "--porcelain=v1", "--untracked-files=all"]),
    );
    const unexpected = status.filter((path) => !declared.includes(path));
    if (unexpected.length > 0) {
      throw new WorkspaceInvariantError(`planning changed undeclared paths: ${unexpected.join(", ")}`);
    }
    const hashes = await this.hashFiles(binding.path, declared);
    if (declared.some((path) => hashes[path] !== expectedHashes[path])) {
      throw new WorkspaceInvariantError("planning artifact hashes do not match");
    }
    await this.checkedAt(binding.path, ["add", "--", ...declared]);
    const commit = await this.gitAt(binding.path, [
      "commit",
      "-m",
      `chore: seal planning artifacts for ${binding.runId}`,
    ]);
    if (commit.exitCode !== 0) {
      throw new WorkspaceInvariantError(commit.stderr.trim());
    }
    const head = await this.checkedAt(binding.path, ["rev-parse", "HEAD"]);
    this.registry.seal(binding.path, head);
    await this.persistRegistry();
    return { commit: head, hashes };
  }

  public async patchIdForRange(base: string, head: string): Promise<string> {
    const diff = await this.process.runBytes(
      "git",
      ["-C", this.repository.root, "diff", "--binary", base, head],
      { shell: false },
    );
    if (diff.exitCode !== 0) throw new WorkspaceInvariantError(diff.stderr);
    return sha256(diff.stdout);
  }

  public async sealImplementation(
    binding: LifecycleWorktreeBinding,
    reportedCommit: string,
  ): Promise<SealedImplementation> {
    if (binding.role !== "implementation" && binding.role !== "remediation") {
      throw new WorkspaceInvariantError("workspace is not writable implementation ownership");
    }
    const head = await this.checkedAt(binding.path, ["rev-parse", "HEAD"]);
    const status = normalizeStatus(
      await this.checkedAt(binding.path, ["status", "--porcelain=v1", "--untracked-files=all"]),
    );
    if (head !== reportedCommit || status.length > 0) {
      throw new WorkspaceInvariantError(
        "implementation result is not a clean reported commit",
      );
    }
    if (!(await this.repository.isAncestor(binding.baseCommit, head))) {
      throw new WorkspaceInvariantError(
        "implementation head is not descended from its assigned base",
      );
    }
    const changed = await this.checkedAt(binding.path, [
      "diff",
      "--name-only",
      "--no-renames",
      binding.baseCommit,
      head,
    ]);
    const changedPaths = changed === "" ? [] : changed.split("\n").sort();
    const outsideOwnership = changedPaths.filter(
      (path) => !binding.ownedPaths.some((pattern) => matchesOwnedPath(path, pattern)),
    );
    if (outsideOwnership.length > 0) {
      throw new WorkspaceInvariantError(
        `implementation changed paths outside ownership: ${outsideOwnership.join(", ")}`,
      );
    }
    const sealed: SealedImplementation = {
      baseCommit: binding.baseCommit,
      headCommit: head,
      sourceTree: await this.checkedAt(binding.path, ["rev-parse", `${head}^{tree}`]),
      patchId: await this.patchIdForRange(binding.baseCommit, head),
      changedPaths,
    };
    this.registry.seal(binding.path, head);
    await this.persistRegistry();
    return sealed;
  }

  public async validateReview(binding: LifecycleWorktreeBinding): Promise<void> {
    if (binding.role !== "review" && binding.role !== "verification") {
      throw new WorkspaceInvariantError("workspace is not read-only review ownership");
    }
    const head = await this.checkedAt(binding.path, ["rev-parse", "HEAD"]);
    const status = normalizeStatus(
      await this.checkedAt(binding.path, ["status", "--porcelain=v1", "--untracked-files=all"]),
    );
    if (head !== binding.commit || status.length > 0) {
      throw new WorkspaceInvariantError("review workspace mutated or moved");
    }
  }

  private async assertRegisteredIdentity(binding: LifecycleWorktreeBinding): Promise<void> {
    const entry = this.registry.get(binding.path);
    if (!entry || entry.binding.id !== binding.id) {
      throw new WorkspaceInvariantError("worktree is not registered to this lifecycle");
    }
    const listed = await this.checkedAt(this.repository.root, ["worktree", "list", "--porcelain"]);
    const paths = listed
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    if (!paths.includes(binding.path)) {
      throw new WorkspaceInvariantError("registered worktree identity is no longer present");
    }
  }

  public async releaseImplementation(
    binding: LifecycleWorktreeBinding,
  ): Promise<void> {
    await this.assertRegisteredIdentity(binding);
    const entry = this.registry.get(binding.path)!;
    if (
      (binding.role !== "implementation" && binding.role !== "remediation") ||
      !entry.sealed ||
      entry.sealedHead === undefined
    ) {
      throw new WorkspaceInvariantError(
        "refusing to remove an unsealed implementation workspace",
      );
    }
    const head = await this.checkedAt(binding.path, ["rev-parse", "HEAD"]);
    const status = normalizeStatus(
      await this.checkedAt(binding.path, ["status", "--porcelain=v1", "--untracked-files=all"]),
    );
    if (head !== entry.sealedHead || status.length > 0) {
      throw new WorkspaceInvariantError(
        "refusing to remove a dirty implementation workspace",
      );
    }
    await this.removeRegistered(binding, false);
  }

  private async removeRegistered(
    binding: LifecycleWorktreeBinding,
    force: boolean,
  ): Promise<void> {
    await this.assertRegisteredIdentity(binding);
    if (!binding.writable) await makeTreeOwnerWritable(binding.path);
    const result = await this.gitAt(this.repository.root, [
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      binding.path,
    ]);
    if (result.exitCode !== 0) throw new WorkspaceInvariantError(result.stderr.trim());
    this.registry.remove(binding.path);
    await this.persistRegistry();
  }

  public async releasePath(path: string): Promise<void> {
    const entry = this.registry.get(path);
    if (!entry) throw new WorkspaceInvariantError("refusing to remove an unregistered worktree");
    if (
      entry.binding.role === "implementation" ||
      entry.binding.role === "remediation"
    ) {
      await this.releaseImplementation(entry.binding);
      return;
    }
    await this.removeRegistered(entry.binding, false);
  }

  public async releaseCompleted(binding: LifecycleWorktreeBinding): Promise<void> {
    const entry = this.registry.get(binding.path);
    if (entry === undefined) return;
    if (entry.binding.id !== binding.id) {
      throw new WorkspaceInvariantError("registered worktree binding mismatch");
    }
    await this.releasePath(binding.path);
  }

  public async cleanupAll(): Promise<void> {
    for (const entry of [...this.registry.list()].reverse()) {
      const { binding } = entry;
      if (
        (binding.role === "implementation" || binding.role === "remediation") &&
        !entry.sealed
      ) {
        continue;
      }
      try {
        await this.removeRegistered(binding, binding.role === "review" || binding.role === "verification");
      } catch {
        // Cleanup is best effort. Writable, unsealed, or identity-mismatched
        // worktrees stay quarantined for explicit operator recovery.
      }
    }
    if (this.registry.list().length === 0) {
      await rm(join(this.workspaceRoot, "registry.json"), { force: true });
      try {
        await rmdir(this.workspaceRoot);
      } catch {
        // Another run or an operator-owned quarantine may still use this root.
      }
    }
  }
}

export async function validateReview(
  binding: LifecycleWorktreeBinding,
): Promise<void> {
  const process = new NodeProcessRunner();
  const head = await process.run("git", ["rev-parse", "HEAD"], {
    cwd: binding.path,
    shell: false,
  });
  const status = await process.run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: binding.path, shell: false },
  );
  if (
    head.exitCode !== 0 ||
    status.exitCode !== 0 ||
    head.stdout.trim() !== binding.commit ||
    normalizeStatus(status.stdout).length > 0
  ) {
    throw new WorkspaceInvariantError("review workspace mutated or moved");
  }
}
