import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { createAssignment } from "../../src/core/assignment.js";
import { ChildPiPlanningPort } from "../../src/pi/child-planning-port.js";
import { createManagedPiRuntime } from "../../src/runtime/managed/factory.js";
import { createTempGitRepository } from "../support/git-fixtures.js";
import { installPackedHarness, packHarness } from "../support/package-consumer.js";

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
  const implementationPath = `${repo.path}-implementation`;
  const reviewPath = `${repo.path}-review`;
  let packed: Awaited<ReturnType<typeof packHarness>> | undefined;
  let consumer: Awaited<ReturnType<typeof installPackedHarness>> | undefined;
  try {
    const root = process.cwd();
    const runtime = await createManagedPiRuntime({
      profiles: parse(await readFile(join(root, "src/defaults/profiles.yaml"), "utf8")),
      runtimeVersion: "0.1.0",
      packageRoot: root,
      projectCredentials: true,
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
    const planReceipt = await planning.run({
      stage: "plan",
      command: "/speckit.plan",
      correlationId: "real-codex-plan-1",
      artifactPaths,
      baseline: { hashes: planningReceipt.afterHashes },
    }, {
      instruction: "Create specs/feature/plan.md for FR-001 and SC-001. Use src/add.js and node --test. Do not change any other file.",
    });
    expect(planReceipt.profileId).toBe("planner-codex");
    expect(await readFile(join(repo.path, artifactPaths.plan), "utf8")).toContain("src/add.js");
    await mkdir(join(repo.path, "specs/feature"), { recursive: true });
    await writeFile(join(repo.path, artifactPaths.tasks), [
      "# Tasks", "",
      "- [ ] T001 Implement add | deps=[] | ac=[\"FR-001\",\"SC-001\"] | paths=[\"src/add.js\"]",
      "",
    ].join("\n"));
    await execa("git", ["add", "specs"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "docs: add approved Spec Kit artifacts"], { cwd: repo.path });
    const base = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo.path })).stdout;
    await execa("git", ["worktree", "add", "-b", "harness/REAL001-T001", implementationPath, base], { cwd: repo.path });
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
      worktree: {
        role: "implementation",
        path: implementationPath,
        branch: "harness/REAL001-T001",
        commit: base,
        writable: true,
      },
    });
    const prepared = await runtime.workerRuntime.prepare(assignment);
    const handle = await runtime.workerRuntime.launch(prepared);
    const result = await runtime.workerRuntime.collect(prepared);
    expect(result).toMatchObject({ status: "valid", result: { role: "implementation", outcome: "completed" } });
    if (
      result.status !== "valid" || result.result.outcome !== "completed" ||
      !("role" in result.result) || result.result.role !== "implementation"
    ) throw new Error("Devin did not produce a completed implementation result");
    expect((await execa("node", ["--test"], { cwd: implementationPath })).exitCode).toBe(0);
    expect(await readFile(join(implementationPath, "src/add.js"), "utf8")).toContain("add");

    const restarted = await createManagedPiRuntime({
      profiles: parse(await readFile(join(root, "src/defaults/profiles.yaml"), "utf8")),
      runtimeVersion: "0.1.0",
      packageRoot: root,
      projectCredentials: true,
    });
    await expect(restarted.workerRuntime.recover(prepared, {
      attemptId: prepared.attemptId,
      process: handle.process,
    })).resolves.toMatchObject({
      status: "observed",
      result: { role: "implementation", outcome: "completed" },
    });

    const candidate = result.result.commit;
    await execa("git", ["worktree", "add", "--detach", reviewPath, candidate], { cwd: repo.path });
    let review: Awaited<ReturnType<typeof runtime.workerRuntime.collect>> = {
      status: "invalid",
      reason: "review was not attempted",
    };
    // Match the bounded retry budget in the shipped workflow. Subscription
    // agents can occasionally terminate a turn before emitting the contract.
    for (let attempt = 1; attempt <= 3 && review.status === "invalid"; attempt += 1) {
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
    await execa("git", ["merge", "--ff-only", candidate], { cwd: repo.path });
    expect((await execa("git", ["rev-parse", "HEAD"], { cwd: repo.path })).stdout).toBe(candidate);
    expect((await execa("node", ["--test"], { cwd: repo.path })).exitCode).toBe(0);

    packed = await packHarness();
    consumer = await installPackedHarness(packed, { pi: "0.86.1", typebox: "1.3.34" });
    await consumer.loadPublicEntrypoint();
    await expect(consumer.loadWithPiResourceLoader()).resolves.toEqual({ errors: [] });
  } finally {
    await consumer?.cleanup();
    await packed?.cleanup();
    await execa("git", ["worktree", "remove", "--force", reviewPath], { cwd: repo.path, reject: false });
    await execa("git", ["worktree", "remove", "--force", implementationPath], { cwd: repo.path, reject: false });
    if (process.env.KEEP_REAL_E2E === "1") {
      process.stderr.write(`preserved real E2E repository: ${repo.path}\n`);
    } else {
      await repo.cleanup();
    }
  }
}, 10 * 60_000);
