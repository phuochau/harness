import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  GitIntegrateAction,
  type GitIntegrateIntent,
} from "../../../src/actions/git-integrate.js";
import {
  GitProjectTaskStatusAction,
  tasksSemanticHash,
  type ProjectTaskStatusIntent,
} from "../../../src/actions/git-project-task-status.js";
import { GitPushAction } from "../../../src/actions/git-push.js";
import { GitVerifyAction } from "../../../src/actions/git-verify.js";
import { GitHubPullRequestAction } from "../../../src/actions/github-pr.js";
import type {
  ActionContext,
  SealedImplementation,
} from "../../../src/actions/types.js";
import { NativeGitActionPort } from "../../../src/git/action-port.js";
import { NodeProcessRunner } from "../../../src/git/process.js";
import { FakeProcessRunner } from "../../support/fake-process.js";
import { createTempGitRepository } from "../../support/git-fixtures.js";
import { FakeClock } from "../../support/fake-clock.js";

const TASKS = [
  "# Tasks",
  "",
  "- [ ] T001 Implement first feature",
  "- [ ] T002 Implement second feature",
  "",
].join("\n");

function context(
  git: NativeGitActionPort,
  process = new NodeProcessRunner(),
): ActionContext {
  return {
    isRecovery: false,
    process,
    git,
    approvals: { get: async () => undefined },
    clock: new FakeClock(),
    signal: new AbortController().signal,
  };
}

async function gitRun(cwd: string, argv: readonly string[]): Promise<string> {
  const process = new NodeProcessRunner();
  const result = await process.run("git", argv, { cwd, shell: false });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function multiCommitFixture() {
  const repo = await createTempGitRepository("git actions", {
    "specs/F023/tasks.md": TASKS,
  });
  const run = await repo.repository.ensureRunBranch("F023", repo.initialCommit);
  const task = await repo.repository.ensureTaskBranch(
    "F023",
    "T001",
    run.commit,
  );
  const taskParent = await mkdtemp(join(tmpdir(), "pi harness source "));
  const taskPath = join(taskParent, "task worktree");
  await gitRun(repo.path, ["worktree", "add", taskPath, task.name]);
  const commit = async (name: string, contents: string) => {
    await mkdir(dirname(join(taskPath, name)), { recursive: true });
    await writeFile(join(taskPath, name), contents, "utf8");
    await gitRun(taskPath, ["add", name]);
    await gitRun(taskPath, ["commit", "-m", `add ${name}`]);
    return gitRun(taskPath, ["rev-parse", "HEAD"]);
  };
  const first = await commit("first.txt", "first\n");
  const head = await commit("second.txt", "second\n");
  await gitRun(repo.path, ["worktree", "remove", taskPath]);
  await rm(taskParent, { recursive: true, force: true });
  const port = new NativeGitActionPort(repo.path);
  const sealedChange: SealedImplementation = {
    baseCommit: task.baseCommit,
    headCommit: head,
    sourceTree: await port.revParse(`${head}^{tree}`),
    patchId: await port.patchIdForRange(task.baseCommit, head),
    changedPaths: ["first.txt", "second.txt"],
  };
  const intent: GitIntegrateIntent = {
    action: "git.integrate",
    idempotencyKey: "integrate:F023:T001:1",
    recovery: "reconcilable",
    laneKey: "integration-pipeline:F023",
    input: { expectedRunHead: run.commit, sealedChange },
  };
  return {
    repo,
    run,
    first,
    head,
    port,
    sealedChange,
    intent,
    cleanup: repo.cleanup,
  };
}

it("integrates every commit in the sealed source range exactly once", async () => {
  const fixture = await multiCommitFixture();
  try {
    const handler = new GitIntegrateAction();
    const output = await handler.execute(context(fixture.port), fixture.intent);
    expect(await fixture.port.treeContains(output.candidateCommit, ["first.txt", "second.txt"])).toBe(true);
    expect(await fixture.port.revParse(fixture.run.name)).toBe(fixture.run.commit);
    await expect(
      handler.reconcile(context(fixture.port), fixture.intent),
    ).resolves.toEqual({ status: "observed", output });
    await expect(
      handler.execute(context(fixture.port), fixture.intent),
    ).resolves.toEqual(output);
  } finally {
    await fixture.cleanup();
  }
});

it("treats a moved candidate ref as indeterminate", async () => {
  const fixture = await multiCommitFixture();
  try {
    const handler = new GitIntegrateAction();
    const output = await handler.execute(context(fixture.port), fixture.intent);
    await fixture.port.updateRefCas(
      output.candidateRef,
      fixture.sealedChange.headCommit,
      output.candidateCommit,
    );
    await expect(
      handler.reconcile(context(fixture.port), fixture.intent),
    ).resolves.toMatchObject({
      status: "indeterminate",
      evidence: expect.arrayContaining([expect.stringMatching(/integration identity/)]),
    });
  } finally {
    await fixture.cleanup();
  }
});

it("atomically promotes a verified candidate with one checkbox transition", async () => {
  const fixture = await multiCommitFixture();
  try {
    const integrate = new GitIntegrateAction();
    const candidate = await integrate.execute(context(fixture.port), fixture.intent);
    const verificationEventId = "verification:F023:T001:1";
    const project = new GitProjectTaskStatusAction({
      get: async (id) =>
        id === verificationEventId
          ? { eventType: "verification.passed", commit: candidate.candidateCommit }
          : undefined,
    });
    const projectionIntent: ProjectTaskStatusIntent = {
      action: "git.project-task-status",
      idempotencyKey: "finalize:F023:T001:1",
      recovery: "reconcilable",
      laneKey: "run-mutation:F023",
      input: {
        runRef: fixture.run.name,
        expectedRunHead: fixture.run.commit,
        candidateCommit: candidate.candidateCommit,
        integrationIdentity: {
          effectKey: fixture.intent.idempotencyKey,
          expectedRunHead: fixture.run.commit,
          change: fixture.sealedChange,
        },
        verificationEventId,
        taskId: "T001",
        tasksPath: "specs/F023/tasks.md",
        tasksSemanticHash: tasksSemanticHash(TASKS),
      },
    };
    const output = await project.execute(context(fixture.port), projectionIntent);
    expect(await fixture.port.revParse(fixture.run.name)).toBe(output.targetCommit);
    expect(await fixture.port.treeContains(output.targetCommit, ["first.txt", "second.txt"])).toBe(true);
    expect(
      await fixture.port.readTextAt(output.targetCommit, "specs/F023/tasks.md"),
    ).toContain("- [x] T001 Implement first feature");
    await expect(
      project.reconcile(context(fixture.port), projectionIntent),
    ).resolves.toEqual({ status: "observed", output });
    await expect(
      project.execute(context(fixture.port), projectionIntent),
    ).resolves.toEqual(output);
  } finally {
    await fixture.cleanup();
  }
});

it("cleans a conflicted candidate workspace without moving the run branch", async () => {
  const fixture = await multiCommitFixture();
  try {
    const conflictingTree = await fixture.port.buildTreeWithTextFile(
      fixture.run.commit,
      "first.txt",
      "run-side content\n",
    );
    const conflictingHead = await fixture.port.commitTree(conflictingTree, {
      parent: fixture.run.commit,
      trailers: { "Harness-Test": "conflict" },
    });
    await fixture.port.updateRefCas(
      fixture.run.name,
      conflictingHead,
      fixture.run.commit,
    );
    const intent: GitIntegrateIntent = {
      ...fixture.intent,
      idempotencyKey: "integrate:F023:T001:conflict",
      input: {
        ...fixture.intent.input,
        expectedRunHead: conflictingHead,
      },
    };
    await expect(
      new GitIntegrateAction().execute(context(fixture.port), intent),
    ).rejects.toThrow(/integration conflict/);
    expect(await fixture.port.revParse(fixture.run.name)).toBe(conflictingHead);
    const worktrees = await gitRun(fixture.repo.path, ["worktree", "list", "--porcelain"]);
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

it("leaves a newer run head unchanged when finalization loses the CAS", async () => {
  const fixture = await multiCommitFixture();
  try {
    const candidate = await new GitIntegrateAction().execute(
      context(fixture.port),
      fixture.intent,
    );
    const newer = await fixture.repo.repository.commitOnBranch(
      fixture.run.name,
      "another integration won",
    );
    const project = new GitProjectTaskStatusAction({
      get: async () => ({
        eventType: "verification.passed",
        commit: candidate.candidateCommit,
      }),
    });
    const intent: ProjectTaskStatusIntent = {
      action: "git.project-task-status",
      idempotencyKey: "finalize:F023:T001:stale",
      recovery: "reconcilable",
      laneKey: "run-mutation:F023",
      input: {
        runRef: fixture.run.name,
        expectedRunHead: fixture.run.commit,
        candidateCommit: candidate.candidateCommit,
        integrationIdentity: {
          effectKey: fixture.intent.idempotencyKey,
          expectedRunHead: fixture.run.commit,
          change: fixture.sealedChange,
        },
        verificationEventId: "verification:stale",
        taskId: "T001",
        tasksPath: "specs/F023/tasks.md",
        tasksSemanticHash: tasksSemanticHash(TASKS),
      },
    };
    await expect(project.execute(context(fixture.port), intent)).rejects.toThrow(
      /stale run head/,
    );
    expect(await fixture.port.revParse(fixture.run.name)).toBe(newer);
  } finally {
    await fixture.cleanup();
  }
});

it("binds verification and push to immutable commit identities", async () => {
  const fixture = await multiCommitFixture();
  try {
    const verify = new GitVerifyAction();
    await expect(
      verify.execute(context(fixture.port), {
        action: "git.verify",
        idempotencyKey: "verify:candidate",
        recovery: "reconcilable",
        laneKey: "verification:T001",
        input: {
          commit: fixture.run.commit,
          command: { exitCode: 0, stdout: "ok", stderr: "" },
        },
      }),
    ).resolves.toMatchObject({ commit: fixture.run.commit, passed: true });

    const process = new FakeProcessRunner();
    process.queue({ exitCode: 0, stdout: "", stderr: "" });
    const push = new GitPushAction();
    await expect(
      push.execute(context(fixture.port, process as NodeProcessRunner), {
        action: "git.push",
        idempotencyKey: "push:F023",
        recovery: "reconcilable",
        laneKey: "run-mutation:F023",
        input: {
          localRef: fixture.run.name,
          remote: "origin",
          remoteRef: "refs/heads/harness/F023",
          reviewedCommit: fixture.run.commit,
          cwd: fixture.repo.path,
        },
      }),
    ).resolves.toMatchObject({ commit: fixture.run.commit });
    expect(process.calls[0]).toMatchObject({
      executable: "git",
      argv: [
        "push",
        "origin",
        `${fixture.run.commit}:refs/heads/harness/F023`,
      ],
    });
  } finally {
    await fixture.cleanup();
  }
});

it("observes an existing pull request by head, base, and reviewed commit", async () => {
  const process = new FakeProcessRunner();
  process.queue({
    exitCode: 0,
    stdout: JSON.stringify([
      { number: 1, url: "https://example.invalid/pr/1", headRefOid: "abc123" },
    ]),
    stderr: "",
  });
  const fixture = await createTempGitRepository("pr action");
  try {
    const port = new NativeGitActionPort(fixture.path);
    const action = new GitHubPullRequestAction();
    await expect(
      action.reconcile(context(port, process as NodeProcessRunner), {
        action: "github.pull-request",
        idempotencyKey: "pr:F023",
        recovery: "reconcilable",
        laneKey: "run-mutation:F023",
        input: {
          cwd: fixture.path,
          head: "harness/run-F023",
          base: "main",
          title: "Feature F023",
          reviewedCommit: "abc123",
        },
      }),
    ).resolves.toEqual({
      status: "observed",
      output: { number: 1, url: "https://example.invalid/pr/1", headRefOid: "abc123" },
    });
  } finally {
    await fixture.cleanup();
  }
});

it("does not reconcile a remote ref at a different commit", async () => {
  const process = new FakeProcessRunner();
  process.queue({
    exitCode: 0,
    stdout: `${"d".repeat(40)}\trefs/heads/harness/F023`,
    stderr: "",
  });
  const fixture = await createTempGitRepository("remote mismatch");
  try {
    const port = new NativeGitActionPort(fixture.path);
    await expect(
      new GitPushAction().reconcile(context(port, process as NodeProcessRunner), {
        action: "git.push",
        idempotencyKey: "push:F023:mismatch",
        recovery: "reconcilable",
        laneKey: "run-mutation:F023",
        input: {
          localRef: "main",
          remote: "origin",
          remoteRef: "refs/heads/harness/F023",
          reviewedCommit: fixture.initialCommit,
          cwd: fixture.path,
        },
      }),
    ).resolves.toMatchObject({
      status: "indeterminate",
      evidence: expect.arrayContaining([expect.stringMatching(/remote ref/)]),
    });
  } finally {
    await fixture.cleanup();
  }
});
