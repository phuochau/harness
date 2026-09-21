import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  WorktreeLifecycle,
  WorkspaceInvariantError,
} from "../../../src/git/workspace-lifecycle.js";
import { createTempGitRepository } from "../../support/git-fixtures.js";

async function fixture() {
  const repo = await createTempGitRepository("worktree lifecycle");
  const run = await repo.repository.ensureRunBranch("F023", repo.initialCommit);
  const workspaceRoot = join(
    repo.path,
    "..",
    `${repo.path.split("/").at(-1)}-workspaces`,
  );
  const manager = await WorktreeLifecycle.open({
    repository: repo.repository,
    workspaceRoot,
  });
  return {
    repo,
    manager,
    run,
    workspaceRoot,
    cleanup: async () => {
      await manager.cleanupAll();
      await repo.cleanup();
    },
  };
}

async function commitFile(
  path: string,
  name: string,
  contents: string,
): Promise<string> {
  await mkdir(dirname(join(path, name)), { recursive: true });
  await writeFile(join(path, name), contents, "utf8");
  const { execa } = await import("execa");
  await execa("git", ["add", name], { cwd: path });
  await execa("git", ["commit", "-m", `change ${name}`], { cwd: path });
  return (await execa("git", ["rev-parse", "HEAD"], { cwd: path })).stdout;
}

it("reviews in a separate detached worktree after implementer release", async () => {
  const context = await fixture();
  try {
    const task = await context.repo.repository.ensureTaskBranch(
      "F023",
      "T001",
      context.run.commit,
    );
    const implementation = await context.manager.openImplementation({
      runId: "F023",
      taskId: "T001",
      attempt: 1,
      branch: task.name,
      baseCommit: task.baseCommit,
      ownedPaths: ["src/**"],
    });
    const resultCommit = await commitFile(
      implementation.path,
      "src/feature.ts",
      "export const feature = true;\n",
    );
    const sealed = await context.manager.sealImplementation(
      implementation,
      resultCommit,
    );
    await expect(
      context.manager.openReview({
        runId: "F023",
        taskId: "T001",
        attempt: 1,
        commit: sealed.headCommit,
      }),
    ).rejects.toThrow(/implementation workspace active/);

    await context.manager.releaseImplementation(implementation);
    const review = await context.manager.openReview({
      runId: "F023",
      taskId: "T001",
      attempt: 1,
      commit: sealed.headCommit,
    });
    expect(review).toMatchObject({
      branch: null,
      writable: false,
      commit: sealed.headCommit,
    });
    expect(review.path).not.toBe(implementation.path);
    await context.manager.validateReview(review);
  } finally {
    await context.cleanup();
  }
});

it("seals the complete change when a worker creates multiple commits", async () => {
  const context = await fixture();
  try {
    const task = await context.repo.repository.ensureTaskBranch(
      "F023",
      "T002",
      context.run.commit,
    );
    const implementation = await context.manager.openImplementation({
      runId: "F023",
      taskId: "T002",
      attempt: 1,
      branch: task.name,
      baseCommit: task.baseCommit,
      ownedPaths: ["src/**"],
    });
    const first = await commitFile(implementation.path, "src/one.ts", "one\n");
    const head = await commitFile(implementation.path, "src/two.ts", "two\n");
    const sealed = await context.manager.sealImplementation(
      implementation,
      head,
    );
    expect(sealed).toMatchObject({
      baseCommit: implementation.baseCommit,
      headCommit: head,
    });
    expect(sealed.patchId).toBe(
      await context.manager.patchIdForRange(implementation.baseCommit, head),
    );
    expect(sealed.changedPaths).toEqual(["src/one.ts", "src/two.ts"]);
    expect(first).not.toBe(head);
  } finally {
    await context.cleanup();
  }
});

it("seals the complete planning artifact tree on the run branch", async () => {
  const context = await fixture();
  try {
    const planning = await context.manager.openPlanning({
      runId: "F023",
      runBranch: context.run.name,
      artifactPaths: ["spec.md", "plan.md", "tasks.md"],
    });
    await writeFile(join(planning.path, "spec.md"), "# Spec\n", "utf8");
    await writeFile(join(planning.path, "plan.md"), "# Plan\n", "utf8");
    await writeFile(join(planning.path, "tasks.md"), "- [ ] T001\n", "utf8");
    const expected = await context.manager.hashFiles(planning.path, [
      "spec.md",
      "plan.md",
      "tasks.md",
    ]);
    const sealed = await context.manager.sealPlanningArtifacts(
      planning,
      expected,
    );
    expect(sealed.commit).toBe(
      await context.repo.repository.revParse(context.run.name),
    );
    expect(sealed.hashes).toEqual(expected);
  } finally {
    await context.cleanup();
  }
});

it("rejects a dirty review worktree", async () => {
  const context = await fixture();
  try {
    const review = await context.manager.openReview({
      runId: "F023",
      taskId: "T003",
      attempt: 1,
      commit: context.run.commit,
    });
    await chmod(review.path, 0o755);
    await writeFile(join(review.path, "changed.txt"), "mutation", "utf8");
    await expect(context.manager.validateReview(review)).rejects.toThrow(
      /review workspace mutated/,
    );
  } finally {
    await context.cleanup();
  }
});

it("refuses to remove an unregistered worktree", async () => {
  const context = await fixture();
  try {
    await expect(
      context.manager.releasePath(join(context.repo.path, "not-registered")),
    ).rejects.toBeInstanceOf(WorkspaceInvariantError);
  } finally {
    await context.cleanup();
  }
});

it("retains an unsealed implementation for operator recovery", async () => {
  const context = await fixture();
  try {
    const task = await context.repo.repository.ensureTaskBranch(
      "F023",
      "T004",
      context.run.commit,
    );
    const implementation = await context.manager.openImplementation({
      runId: "F023",
      taskId: "T004",
      attempt: 1,
      branch: task.name,
      baseCommit: task.baseCommit,
      ownedPaths: ["src/**"],
    });
    await expect(
      context.manager.releasePath(implementation.path),
    ).rejects.toThrow(/unsealed implementation/);
    await context.manager.sealImplementation(
      implementation,
      implementation.baseCommit,
    );
    await context.manager.releaseImplementation(implementation);
  } finally {
    await context.cleanup();
  }
});

it("recovers registered ownership after a controller restart", async () => {
  const context = await fixture();
  try {
    const planning = await context.manager.openPlanning({
      runId: "F023",
      runBranch: context.run.name,
      artifactPaths: ["tasks.md"],
    });
    await writeFile(join(planning.path, "tasks.md"), "- [ ] T001\n", "utf8");
    const hashes = await context.manager.hashFiles(planning.path, ["tasks.md"]);
    await context.manager.sealPlanningArtifacts(planning, hashes);

    const restarted = await WorktreeLifecycle.open({
      repository: context.repo.repository,
      workspaceRoot: context.workspaceRoot,
    });
    await restarted.cleanupAll();
    const { execa } = await import("execa");
    const listed = await execa("git", ["worktree", "list", "--porcelain"], {
      cwd: context.repo.path,
    });
    expect(listed.stdout).not.toContain(planning.path);
  } finally {
    await context.cleanup();
  }
});

it("reuses the exact registered attempt and releases completed work idempotently", async () => {
  const context = await fixture();
  try {
    const task = await context.repo.repository.ensureTaskBranch(
      "F023",
      "T005",
      context.run.commit,
    );
    const input = {
      runId: "F023",
      taskId: "T005",
      attempt: 1,
      branch: task.name,
      baseCommit: task.baseCommit,
      ownedPaths: ["src/**"],
    } as const;
    const first = await context.manager.openImplementation(input);
    await expect(context.manager.openImplementation(input)).resolves.toEqual(first);
    await context.manager.sealImplementation(first, first.commit);
    await context.manager.releaseCompleted(first);
    await expect(context.manager.releaseCompleted(first)).resolves.toBeUndefined();
  } finally {
    await context.cleanup();
  }
});
