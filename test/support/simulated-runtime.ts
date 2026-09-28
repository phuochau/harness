import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import type { ProcessRunner } from "../../src/actions/types.js";
import type { WorkerResult } from "../../src/contracts/worker-result.js";
import type { WorkerAssignment } from "../../src/core/assignment.js";
import { NodeProcessRunner } from "../../src/git/process.js";
import type { PiProcessRecord } from "../../src/runtime/pi-process/types.js";
import type {
  PreparedPiAttempt,
  PiWorkerHandle,
} from "../../src/runtime/pi-worker/runtime.js";
import { sha256 } from "../../src/shared/sha256.js";
import { fixtureResolvedProfiles } from "./factories.js";
import { processRecord } from "./pi-process-fixtures.js";

export class SimulatedPiRuntime {
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

export class PullRequestProcess implements ProcessRunner {
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
