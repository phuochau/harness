import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import type { ProcessRunner } from "../../src/actions/types.js";
import { compileWorkflow } from "../../src/config/compile.js";
import type { TaskNode } from "../../src/contracts/task-graph.js";
import type { WorkerResult } from "../../src/contracts/worker-result.js";
import type { WorkerAssignment } from "../../src/core/assignment.js";
import { NodeProcessRunner } from "../../src/git/process.js";
import type { PiProcessRecord } from "../../src/runtime/pi-process/types.js";
import type {
  PreparedPiAttempt,
  PiWorkerHandle,
  PiWorkerRuntime,
} from "../../src/runtime/pi-worker/runtime.js";
import { initializeProductionRun } from "../../src/runtime/production/run.js";
import { composeProductionRun } from "../../src/runtime/production/system.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import { sha256 } from "../../src/shared/sha256.js";
import { semanticHash } from "../../src/speckit/semantic-hash.js";
import { createTempGitRepository } from "../support/git-fixtures.js";
import { fixtureResolvedProfiles } from "../support/factories.js";
import { processRecord } from "../support/pi-process-fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

function tasks(): readonly TaskNode[] {
  return [
    {
      id: "T001",
      description: "Implement one",
      phase: "Build",
      labels: [],
      parallelEligible: true,
      dependsOn: [],
      acceptanceRefs: ["FR-001"],
      ownedPaths: ["src/T001.txt"],
    },
    {
      id: "T002",
      description: "Implement two",
      phase: "Build",
      labels: [],
      parallelEligible: true,
      dependsOn: [],
      acceptanceRefs: ["FR-002"],
      ownedPaths: ["src/T002.txt"],
    },
    {
      id: "T003",
      description: "Integrate three",
      phase: "Integration",
      labels: [],
      parallelEligible: false,
      dependsOn: ["T001", "T002"],
      acceptanceRefs: ["SC-001"],
      ownedPaths: ["src/T003.txt"],
    },
  ];
}

function taskDocument(records: readonly TaskNode[]): string {
  const visible = [
    "# Feature Tasks",
    "",
    "## Phase 1: Build",
    "- [ ] T001 [P] Implement one | deps=[] | ac=[\"FR-001\"] | paths=[\"src/T001.txt\"]",
    "- [ ] T002 [P] Implement two | deps=[] | ac=[\"FR-002\"] | paths=[\"src/T002.txt\"]",
    "",
    "## Phase 2: Integration",
    "- [ ] T003 Integrate three | deps=[\"T001\",\"T002\"] | ac=[\"SC-001\"] | paths=[\"src/T003.txt\"]",
    "",
  ].join("\n");
  return `${visible}<!-- harness-task-metadata:v1\n${canonicalJson({
    schema: "harness/task-metadata/v1",
    tasks: records,
  })}\n-->`;
}

class SimulatedPiRuntime {
  public activeImplementations = 0;
  public maxConcurrentImplementations = 0;
  public readonly workerKinds = new Set<string>();
  private readonly results = new Map<string, WorkerResult>();
  private readonly records = new Map<string, PiProcessRecord>();

  public async prepare(assignment: WorkerAssignment): Promise<PreparedPiAttempt> {
    const profile = fixtureResolvedProfiles().byId[assignment.profileId]!;
    const attemptId = `${assignment.runId}:${assignment.jobId}:${assignment.attempt}`;
    const sessionDir = join(assignment.worktree.path, ".harness-output", "session");
    return {
      attemptId,
      assignment,
      profile,
      prompt: `assignment ${assignment.assignmentHash}`,
      resultPath: join(assignment.worktree.path, ".harness-output", "result.json"),
      launch: {
        attemptId,
        attemptToken: `token-${assignment.assignmentHash}`,
        executable: "/managed/bin/pi",
        argv: ["--mode", "json"],
        cwd: assignment.worktree.path,
        env: {},
        sessionId: `session-${assignment.assignmentHash.slice(7, 19)}`,
        sessionDir,
      },
    };
  }

  private async evidence(
    root: string,
    kinds: readonly string[],
  ): Promise<Array<{ kind: string; path: string; sha256: `sha256:${string}` }>> {
    const output = [];
    await mkdir(join(root, ".harness-output"), { recursive: true });
    for (const [index, kind] of kinds.entries()) {
      const path = `.harness-output/evidence-${index}.json`;
      const body = `${JSON.stringify({ kind, verified: true })}\n`;
      await writeFile(join(root, path), body, "utf8");
      output.push({ kind, path, sha256: sha256(body) });
    }
    return output;
  }

  public async launch(prepared: PreparedPiAttempt): Promise<PiWorkerHandle> {
    const assignment = prepared.assignment;
    this.workerKinds.add(prepared.profile.family);
    const implementation = assignment.role === "implementation";
    if (implementation) {
      this.activeImplementations += 1;
      this.maxConcurrentImplementations = Math.max(
        this.maxConcurrentImplementations,
        this.activeImplementations,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    try {
      let result: WorkerResult;
      if (implementation) {
        const taskId = assignment.taskId!;
        const target = join(assignment.worktree.path, `src/${taskId}.txt`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, `${taskId} implemented by ${prepared.profile.family}\n`, "utf8");
        await execa("git", ["add", `src/${taskId}.txt`], { cwd: assignment.worktree.path });
        await execa("git", ["commit", "-m", `feat: implement ${taskId}`], {
          cwd: assignment.worktree.path,
        });
        const commit = (await execa("git", ["rev-parse", "HEAD"], {
          cwd: assignment.worktree.path,
        })).stdout;
        const evidence = await this.evidence(assignment.worktree.path, [
          "superpower:test-driven-development",
          "superpower:systematic-debugging",
          "superpower:verification-before-completion",
          "command:git status --porcelain",
        ]);
        result = {
          schemaVersion: 1,
          assignmentHash: assignment.assignmentHash,
          role: "implementation",
          outcome: "completed",
          commit,
          evidence,
        };
      } else {
        const evidence = await this.evidence(assignment.worktree.path, [
          "superpower:requesting-code-review",
          "superpower:verification-before-completion",
        ]);
        result = {
          schemaVersion: 1,
          assignmentHash: assignment.assignmentHash,
          role: "review",
          outcome: "approved",
          reviewedCommit: assignment.commit,
          findings: [],
          evidence,
        };
      }
      await writeFile(prepared.resultPath, `${JSON.stringify(result)}\n`, "utf8");
      this.results.set(prepared.attemptId, result);
      const controlDir = prepared.launch.controlDir ?? prepared.launch.sessionDir;
      const receiptPublicKey = prepared.launch.receiptPublicKey;
      if (receiptPublicKey === undefined) throw new Error("missing prepared receipt key");
      const process = processRecord({
        attemptId: prepared.attemptId,
        attemptToken: prepared.launch.attemptToken,
        executable: prepared.launch.executable,
        cwd: prepared.launch.cwd,
        sessionId: prepared.launch.sessionId,
        sessionDir: prepared.launch.sessionDir,
        eventsPath: join(controlDir, "events.jsonl"),
        stderrPath: join(controlDir, "stderr.log"),
        recordPath: join(controlDir, "process.json"),
        providerPath: join(controlDir, "provider.json"),
        receiptPublicKey,
      });
      this.records.set(prepared.attemptId, process);
      return { attemptId: prepared.attemptId, process };
    } finally {
      if (implementation) this.activeImplementations -= 1;
    }
  }

  public async collect(prepared: PreparedPiAttempt) {
    const result = this.results.get(prepared.attemptId);
    return result === undefined
      ? { status: "invalid" as const, reason: "missing simulated result" }
      : { status: "valid" as const, result };
  }

  public async recover(prepared: PreparedPiAttempt) {
    const result = this.results.get(prepared.attemptId);
    return result === undefined
      ? { status: "retry" as const, reason: "simulated interruption" }
      : { status: "observed" as const, result };
  }

  public async observe(handle: PiWorkerHandle) {
    return {
      status: "exited" as const,
      exit: {
        exitCode: 0,
        signal: null,
        terminal: { settled: true, acceptedStopReason: true, completeToolResults: true },
      },
    };
  }

  public async cancel(handle: PiWorkerHandle) {
    return { attemptId: handle.attemptId, signals: [] as const, exit: null };
  }
}

class PullRequestProcess implements ProcessRunner {
  private readonly delegate = new NodeProcessRunner();
  public created = false;
  public head = "";

  public async run(
    executable: string,
    argv: readonly string[],
    options: Parameters<ProcessRunner["run"]>[2],
  ) {
    if (executable !== "gh") return this.delegate.run(executable, argv, options);
    if (argv[0] === "pr" && argv[1] === "list") {
      return {
        exitCode: 0,
        stdout: this.created
          ? JSON.stringify([{ number: 1, url: "https://example.invalid/pr/1", headRefOid: this.head }])
          : "[]",
        stderr: "",
      };
    }
    if (argv[0] === "pr" && argv[1] === "create") {
      const headName = argv[argv.indexOf("--head") + 1]!;
      this.head = (await this.delegate.run(
        "git",
        ["rev-parse", `refs/heads/${headName}`],
        { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), shell: false },
      )).stdout.trim();
      this.created = true;
      return { exitCode: 0, stdout: "https://example.invalid/pr/1\n", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected gh command" };
  }

  public runBytes(
    executable: string,
    argv: readonly string[],
    options: Parameters<ProcessRunner["runBytes"]>[2],
  ) {
    return this.delegate.runBytes(executable, argv, options);
  }
}

it("runs a durable diamond through real Git worktrees, verification, push, and PR", async () => {
  const repo = await createTempGitRepository("production e2e");
  const remote = await mkdtemp(join(tmpdir(), "pi-harness-remote-"));
  cleanup.push(async () => {
    await rm(remote, { recursive: true, force: true });
    await repo.cleanup();
  });
  await execa("git", ["init", "--bare", remote]);
  await execa("git", ["remote", "add", "origin", remote], { cwd: repo.path });

  const workflow = compileWorkflow({
    profiles: fixtureResolvedProfiles(),
    environment: {
      schema: "harness/environment/v1",
      commands: {
        task_verify: ["git", "status", "--porcelain"],
        full_verify: ["git", "status", "--porcelain"],
      },
      pi_packages: [],
    },
    workflow: {
      schema: "harness/v1",
      name: "owned-production-e2e",
      task_model: {
        source: "stages.tasks.outputs.graph",
        complete_when: { stage: "record_task_done" },
      },
      stages: [
        { id: "implement", uses: "worker.execute", runner: { prefer: ["implementer-devin", "implementer-codex", "implementer-claude"] }, foreach: { source: "stages.tasks.outputs.graph", key: "task.id" }, gate: "task.dependencies_done", isolation: "worktree", retry: { max_attempts: 3, max_elapsed_seconds: 3600 } },
        { id: "review", uses: "worker.review", runner: { prefer: ["reviewer-codex", "reviewer-claude", "reviewer-devin"] }, needs: [{ stage: "implement", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" }, policies: { require_different_profile_family: true, scope: "task" }, retry: { max_attempts: 3, max_elapsed_seconds: 3600 }, on_failure: { changes_requested: { retry_stage: "implement" } } },
        { id: "verify", uses: "command.run", needs: [{ stage: "review", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" }, with: { argv: "${commands.task_verify}" }, retry: { max_attempts: 3, max_elapsed_seconds: 3600 }, on_failure: { verification_failed: { retry_stage: "implement" } } },
        { id: "integrate", uses: "git.integrate", needs: [{ stage: "verify", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" } },
        { id: "post_integrate_verify", uses: "command.run", needs: [{ stage: "integrate", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" }, with: { argv: "${commands.task_verify}" }, retry: { max_attempts: 3, max_elapsed_seconds: 3600 }, on_failure: { verification_failed: { retry_stage: "implement" } } },
        { id: "record_task_done", uses: "git.project-task-status", needs: [{ stage: "post_integrate_verify", scope: "same-item" }], foreach: { source: "stages.tasks.outputs.graph", key: "task.id" } },
        { id: "final_verify", uses: "command.run", needs: [{ stage: "record_task_done", scope: "all" }], with: { argv: "${commands.full_verify}" } },
        { id: "final_review", uses: "worker.review", runner: { prefer: ["reviewer-claude", "reviewer-codex", "reviewer-devin"] }, needs: [{ stage: "final_verify", scope: "all" }], policies: { scope: "final_diff" }, on_failure: { changes_requested: { block: "final_review_remediation_required" } } },
        { id: "push", uses: "git.push", needs: [{ stage: "final_review", scope: "all" }] },
        { id: "final_pr", uses: "github.pull-request", needs: [{ stage: "push", scope: "all" }] },
      ],
    },
  });
  const artifactPaths = {
    spec: "specs/feature/spec.md",
    plan: "specs/feature/plan.md",
    tasks: "specs/feature/tasks.md",
    graph: "specs/feature/task-graph.json",
  } as const;
  const initialized = await initializeProductionRun({
    root: repo.path,
    runId: "F300",
    workflowRevision: workflow.revision,
    approvedPreviewHash: `sha256:${"a".repeat(64)}`,
    artifactPaths,
    remote: "origin",
    baseBranch: "main",
  });

  const planningTree = await mkdtemp(join(tmpdir(), "pi-harness-planning-tree-"));
  await rm(planningTree, { recursive: true, force: true });
  await execa("git", ["worktree", "add", planningTree, "harness/plan-F300"], { cwd: repo.path });
  const records = tasks();
  const artifacts: Record<string, string> = {
    [artifactPaths.spec]: "# Specification\n\n- FR-001: One\n- FR-002: Two\n- SC-001: Three\n",
    [artifactPaths.plan]: "# Plan\n\nExecute the diamond.\n",
    [artifactPaths.tasks]: taskDocument(records),
    [artifactPaths.graph]: `${JSON.stringify({
      schema: "harness/task-graph/v1",
      tasksSemanticHash: semanticHash(records),
      tasks: records,
    })}\n`,
  };
  for (const [path, body] of Object.entries(artifacts)) {
    await mkdir(dirname(join(planningTree, path)), { recursive: true });
    await writeFile(join(planningTree, path), body, "utf8");
  }
  await execa("git", ["add", "."], { cwd: planningTree });
  await execa("git", ["commit", "-m", "docs: seal planning artifacts"], { cwd: planningTree });
  const planningCommit = (await execa("git", ["rev-parse", "HEAD"], { cwd: planningTree })).stdout;
  await execa("git", ["update-ref", initialized.manifest.runRef, planningCommit, initialized.manifest.frozenBase], { cwd: repo.path });
  await execa("git", ["worktree", "remove", planningTree], { cwd: repo.path });

  const piWorkers = new SimulatedPiRuntime();
  const process = new PullRequestProcess();
  const system = await composeProductionRun({
    initialized,
    workflow,
    artifactPaths,
    commands: {
      task_verify: ["git", "status", "--porcelain"],
      full_verify: ["git", "status", "--porcelain"],
    },
    pi: {} as any,
    context: {} as any,
    piWorkerRuntime: piWorkers as unknown as PiWorkerRuntime,
    process,
  });
  try {
    await system.controller.enqueue({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: "start:F300",
      payload: { operation: "run" },
    });
    await system.drain();
    const state = await system.readState();
    const verificationEvents = (await readFile(initialized.paths.events, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line))
      .filter((event) => String(event.eventType).startsWith("verification."))
      .map((event) => ({ id: event.idempotencyKey, commit: event.payload.commit }));
    expect(
      state.jobs.final_pr?.state,
      JSON.stringify({ state, verificationEvents }, null, 2),
    ).toBe("DONE");
    expect(state.finalizedTasks).toEqual(expect.objectContaining({
      T001: expect.any(Object),
      T002: expect.any(Object),
      T003: expect.any(Object),
    }));
    expect(piWorkers.maxConcurrentImplementations).toBe(2);
    expect([...piWorkers.workerKinds].sort()).toEqual(["claude", "codex", "devin"]);
    expect(process.created).toBe(true);
    const runHead = await repo.repository.revParse(initialized.manifest.runRef);
    expect(process.head).toBe(runHead);
    const remoteHead = (await execa("git", ["ls-remote", "--refs", "origin", initialized.manifest.runRef], { cwd: repo.path })).stdout.split(/\s+/)[0];
    expect(remoteHead).toBe(runHead);
    const finalTasks = (await execa("git", ["show", `${runHead}:${artifactPaths.tasks}`], { cwd: repo.path })).stdout;
    expect(finalTasks.match(/- \[x\] T00[1-3]/g)).toHaveLength(3);
  } finally {
    await system.dispose();
  }
}, 30_000);
