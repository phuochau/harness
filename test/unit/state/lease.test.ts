import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RunLease } from "../../../src/state/lease.js";
import { resolveRunPaths } from "../../../src/state/paths.js";
import { createTempRepoWithWorktree } from "../../support/state-fixtures.js";

it("places state under the Git common directory and increments fencing", async () => {
  const repo = await createTempRepoWithWorktree();
  try {
    const paths = await resolveRunPaths(repo.worktree, "F023");
    expect(paths.root).toBe(join(repo.commonDir, "harness/runs/F023"));
    const first = await RunLease.acquire(paths, "controller-a");
    await expect(RunLease.acquire(paths, "controller-b")).rejects.toThrow(
      /lease held/,
    );
    await first.release();
    const second = await RunLease.acquire(paths, "controller-b");
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    await expect(first.assertCurrent()).rejects.toThrow(/stale fencing token/);
    await second.release();
  } finally {
    await repo.cleanup();
  }
});

it("permits exactly one concurrent acquisition", async () => {
  const repo = await createTempRepoWithWorktree();
  try {
    const paths = await resolveRunPaths(repo.worktree, "F024");
    const attempts = await Promise.allSettled([
      RunLease.acquire(paths, "controller-a"),
      RunLease.acquire(paths, "controller-b"),
    ]);
    const acquired = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof RunLease.acquire>>> =>
        attempt.status === "fulfilled",
    );
    expect(acquired).toHaveLength(1);
    await acquired[0]!.value.release();
  } finally {
    await repo.cleanup();
  }
});

it("rejects a held lock created by another process", async () => {
  const repo = await createTempRepoWithWorktree();
  try {
    const paths = await resolveRunPaths(repo.worktree, "F025");
    const lease = await RunLease.acquire(paths, "controller-a");
    await writeFile(paths.lease, JSON.stringify({ ownerId: "controller-a", fencingToken: lease.fencingToken, acquiredAt: new Date().toISOString() }));
    await expect(RunLease.acquire(paths, "controller-child")).rejects.toThrow(
      /lease held/,
    );
    await lease.release();
  } finally {
    await repo.cleanup();
  }
});

it("uses an OS-atomic lock directory across child processes", async () => {
  const repo = await createTempRepoWithWorktree();
  try {
    const paths = await resolveRunPaths(repo.worktree, "F026");
    await mkdir(paths.root, { recursive: true });
    const script = `
      import { mkdir, rmdir } from "node:fs/promises";
      try {
        await mkdir(process.env.HARNESS_LOCK_DIR);
        process.stdout.write("acquired");
        await new Promise((resolve) => setTimeout(resolve, 300));
        await rmdir(process.env.HARNESS_LOCK_DIR);
      } catch (error) {
        if (error && error.code === "EEXIST") {
          process.stdout.write("held");
          process.exitCode = 2;
        } else throw error;
      }
    `;
    const attempt = () =>
      new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, HARNESS_LOCK_DIR: paths.lockDir },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0 && code !== 2) reject(new Error(stderr));
          else resolve({ code, stdout });
        });
      });
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((result) => result.stdout === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.stdout === "held")).toHaveLength(1);
  } finally {
    await repo.cleanup();
  }
});
