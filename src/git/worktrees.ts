import { chmod, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export type WorkspaceRole =
  | "planning"
  | "implementation"
  | "review"
  | "verification"
  | "remediation";

export interface LifecycleWorktreeBinding {
  readonly id: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly attempt?: number;
  readonly role: WorkspaceRole;
  readonly path: string;
  readonly branch: string | null;
  readonly commit: string;
  readonly baseCommit: string;
  readonly writable: boolean;
  readonly ownedPaths: readonly string[];
  readonly artifactPaths: readonly string[];
}

export interface RegistryEntry {
  readonly binding: LifecycleWorktreeBinding;
  sealed: boolean;
  sealedHead?: string;
}

export class WorktreeRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  public constructor(entries: readonly RegistryEntry[] = []) {
    for (const entry of entries) {
      this.entries.set(entry.binding.path, {
        binding: entry.binding,
        sealed: entry.sealed,
        ...(entry.sealedHead === undefined ? {} : { sealedHead: entry.sealedHead }),
      });
    }
  }

  public add(binding: LifecycleWorktreeBinding): LifecycleWorktreeBinding {
    if (this.entries.has(binding.path)) {
      throw new Error(`workspace already registered: ${binding.path}`);
    }
    this.entries.set(binding.path, { binding, sealed: false });
    return binding;
  }

  public get(path: string): RegistryEntry | undefined {
    return this.entries.get(path);
  }

  public list(): readonly RegistryEntry[] {
    return [...this.entries.values()];
  }

  public hasActive(role: WorkspaceRole, taskId?: string): boolean {
    return [...this.entries.values()].some(
      ({ binding }) => binding.role === role && binding.taskId === taskId,
    );
  }

  public seal(path: string, head?: string): void {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`workspace is not registered: ${path}`);
    entry.sealed = true;
    if (head !== undefined) entry.sealedHead = head;
  }

  public remove(path: string): void {
    this.entries.delete(path);
  }
}

export function workspacePath(
  root: string,
  input: {
    runId: string;
    role: WorkspaceRole;
    taskId?: string;
    attempt?: number;
  },
): string {
  const parts = [input.runId, input.role];
  if (input.taskId !== undefined) parts.push(input.taskId);
  if (input.attempt !== undefined) parts.push(`attempt-${input.attempt}`);
  return join(root, ...parts);
}

export function assertPathInside(root: string, candidate: string): void {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error(`workspace path escapes its root: ${candidate}`);
  }
}

async function visit(
  path: string,
  operation: (path: string, directory: boolean) => Promise<void>,
): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const child of await readdir(path)) {
      await visit(join(path, child), operation);
    }
  }
  await operation(path, info.isDirectory());
}

export async function makeReviewTreeReadOnly(path: string): Promise<void> {
  const output = join(path, ".harness-output");
  await mkdir(output, { recursive: true, mode: 0o700 });
  await visit(path, async (entry, directory) => {
    if (entry === output || entry.startsWith(`${output}${sep}`)) return;
    await chmod(entry, directory ? 0o555 : 0o444);
  });
}

export async function makeTreeOwnerWritable(path: string): Promise<void> {
  await visit(path, async (entry, directory) => {
    await chmod(entry, directory ? 0o755 : 0o644);
  });
}

export async function canonicalExistingPath(path: string): Promise<string> {
  return realpath(path);
}
