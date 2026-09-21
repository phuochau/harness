import { expect, it } from "vitest";
import {
  createTempGitRepository,
  createTempRepoWithIntegratedDependencies,
} from "../../support/git-fixtures.js";

it("reuses a branch only when it points at the expected base", async () => {
  const repo = await createTempGitRepository("path with spaces");
  try {
    const first = await repo.repository.ensureTaskBranch(
      "F023",
      "T001",
      repo.initialCommit,
    );
    const second = await repo.repository.ensureTaskBranch(
      "F023",
      "T001",
      repo.initialCommit,
    );
    expect(second).toEqual(first);
    const progressed = await repo.repository.commitOnBranch(
      first.name,
      "worker progress",
    );
    await expect(
      repo.repository.ensureTaskBranch("F023", "T001", repo.initialCommit),
    ).rejects.toThrow(/unexpected head/);
    await expect(
      repo.repository.ensureTaskBranch(
        "F023",
        "T001",
        repo.initialCommit,
        progressed,
      ),
    ).resolves.toMatchObject({ commit: progressed });
  } finally {
    await repo.cleanup();
  }
});

it("bases a dependent task on the integrated dependency head", async () => {
  const repo = await createTempRepoWithIntegratedDependencies(["T001", "T002"]);
  try {
    const branch = await repo.repository.ensureTaskBranch(
      "F023",
      "T003",
      repo.integrationHead,
    );
    expect(
      await repo.repository.mergeBase(branch.name, repo.integrationHead),
    ).toBe(repo.integrationHead);
  } finally {
    await repo.cleanup();
  }
});

it("creates and inspects the run branch from a clean repository", async () => {
  const repo = await createTempGitRepository();
  try {
    const run = await repo.repository.ensureRunBranch("F023", repo.initialCommit);
    expect(run).toMatchObject({
      name: "harness/run-F023",
      baseCommit: repo.initialCommit,
      commit: repo.initialCommit,
    });
    await expect(repo.repository.inspect()).resolves.toMatchObject({
      root: repo.path,
      dirty: false,
    });
  } finally {
    await repo.cleanup();
  }
});
