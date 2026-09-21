import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { createAssignment } from "../../src/core/assignment.js";
import { ChildPiPlanningPort } from "../../src/pi/child-planning-port.js";
import { createManagedPiRuntime } from "../../src/runtime/managed/factory.js";
import { createTempGitRepository } from "../support/git-fixtures.js";

const real = process.env.HARNESS_E2E_REAL === "1";

it.runIf(real)("plans with Codex CLI, implements with Devin CLI, and reviews independently with Codex CLI", async () => {
  const supportedNode = Number(process.versions.node.split(".")[0]) >= 26 ||
    (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) >= 22);
  if (!supportedNode) throw new Error("real E2E requires Node >=22.22.2; run it with a supported Node binary");
  const repo = await createTempGitRepository("real pi native", {
    "package.json": '{"type":"module","scripts":{"test":"node --test"}}\n',
    "test/add.test.js": [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/add.js';",
      "test('adds two numbers', () => assert.equal(add(2, 3), 5));",
      "",
    ].join("\n"),
  });
  const reviewPath = `${repo.path}-review`;
  try {
    const root = process.cwd();
    const runtime = await createManagedPiRuntime({
      profiles: parse(await readFile(join(root, "src/defaults/profiles.yaml"), "utf8")),
      runtimeVersion: "0.1.0",
      packageRoot: root,
    });
    const planner = runtime.profiles.byId["planner-codex"]!;
    const planning = new ChildPiPlanningPort({
      root: repo.path,
      profile: planner,
      managed: runtime.managedProfiles[planner.id]!,
      supervisor: runtime.supervisor,
      piExecutable: runtime.piExecutable,
      piExecutableArgs: runtime.piExecutableArgs,
      transportExtensionPath: runtime.transportExtensionPath,
      sessionRoot: join(repo.path, ".harness-real", "planning"),
    });
    const artifactPaths = {
      spec: "specs/feature/spec.md",
      plan: "specs/feature/plan.md",
      tasks: "specs/feature/tasks.md",
      graph: "specs/feature/task-graph.json",
    } as const;
    const planningReceipt = await planning.run({
      stage: "specify",
      command: "/speckit.specify",
      correlationId: "real-codex-specify-1",
      artifactPaths,
      baseline: { hashes: {} },
    }, {
      instruction: "Create specs/feature/spec.md. It must define '- FR-001: add(a,b) returns the numeric sum' and '- SC-001: node --test passes'. Do not change any other file.",
    });
    expect(planningReceipt.profileId).toBe("planner-codex");
    expect(await readFile(join(repo.path, artifactPaths.spec), "utf8")).toContain("FR-001");
    await mkdir(join(repo.path, "specs/feature"), { recursive: true });
    await writeFile(join(repo.path, artifactPaths.tasks), [
      "# Tasks", "",
      "- [ ] T001 Implement add | deps=[] | ac=[\"FR-001\",\"SC-001\"] | paths=[\"src/add.js\"]",
      "",
    ].join("\n"));
    await execa("git", ["add", "specs"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "docs: add approved Spec Kit artifacts"], { cwd: repo.path });
    const base = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo.path })).stdout;
    const assignment = createAssignment({
      runId: "REAL001",
      stageId: "implement",
      jobId: "implement:T001",
      itemKey: "T001",
      taskId: "T001",
      attempt: 1,
      role: "implementation",
      profileId: "implementer-devin",
      profileFamily: "devin",
      workerKind: "devin",
      commit: base,
      allowedPaths: ["src/add.js"],
      requiredDisciplines: ["test-driven-development", "verification-before-completion"],
      verificationCommands: [["node", "--test"]],
      planningArtifacts: [artifactPaths.spec, artifactPaths.tasks],
      worktree: { role: "implementation", path: repo.path, branch: "main", commit: base, writable: true },
    });
    const prepared = await runtime.workerRuntime.prepare(assignment);
    await runtime.workerRuntime.launch(prepared);
    const result = await runtime.workerRuntime.collect(prepared);
    expect(result).toMatchObject({ status: "valid", result: { role: "implementation", outcome: "completed" } });
    if (
      result.status !== "valid" || result.result.outcome !== "completed" ||
      !("role" in result.result) || result.result.role !== "implementation"
    ) throw new Error("Devin did not produce a completed implementation result");
    expect((await execa("node", ["--test"], { cwd: repo.path })).exitCode).toBe(0);
    expect(await readFile(join(repo.path, "src/add.js"), "utf8")).toContain("add");

    const candidate = result.result.commit;
    await execa("git", ["worktree", "add", "--detach", reviewPath, candidate], { cwd: repo.path });
    let review: Awaited<ReturnType<typeof runtime.workerRuntime.collect>> = {
      status: "invalid",
      reason: "review was not attempted",
    };
    for (let attempt = 1; attempt <= 2 && review.status === "invalid"; attempt += 1) {
      const reviewAssignment = createAssignment({
        runId: "REAL001",
        stageId: "review",
        jobId: "review:T001",
        itemKey: "T001",
        taskId: "T001",
        attempt,
        role: "review",
        profileId: "reviewer-codex",
        profileFamily: "codex",
        workerKind: "codex",
        implementationProfileFamily: "devin",
        implementationWorkerKind: "devin",
        commit: candidate,
        allowedPaths: ["src/add.js"],
        requiredDisciplines: ["verification-before-completion"],
        verificationCommands: [["node", "--test"]],
        planningArtifacts: [artifactPaths.spec, artifactPaths.tasks],
        worktree: {
          role: "review",
          path: reviewPath,
          branch: null,
          commit: candidate,
          writable: false,
        },
      });
      const preparedReview = await runtime.workerRuntime.prepare(reviewAssignment);
      await runtime.workerRuntime.launch(preparedReview);
      review = await runtime.workerRuntime.collect(preparedReview);
    }
    if (review.status !== "valid") throw new Error(`Codex review result invalid: ${review.reason}`);
    expect(review).toMatchObject({
      status: "valid",
      result: { role: "review", outcome: "approved", reviewedCommit: candidate },
    });
    expect((await execa("git", ["status", "--short", "--untracked-files=no"], { cwd: reviewPath })).stdout).toBe("");
  } finally {
    await execa("git", ["worktree", "remove", "--force", reviewPath], { cwd: repo.path, reject: false });
    if (process.env.KEEP_REAL_E2E === "1") {
      process.stderr.write(`preserved real E2E repository: ${repo.path}\n`);
    } else {
      await repo.cleanup();
    }
  }
}, 10 * 60_000);
