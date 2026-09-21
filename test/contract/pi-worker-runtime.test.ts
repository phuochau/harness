import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiWorkerRuntime } from "../../src/runtime/pi-worker/runtime.js";
import type {
  PiLaunchSpec,
  PiProcessExit,
  PiProcessRecord,
  PiProcessSupervisor,
} from "../../src/runtime/pi-process/types.js";
import { fixtureResolvedProfiles } from "../support/factories.js";
import { contractAssignment, completedResultText } from "../support/worker-fixtures.js";
import { processRecord } from "../support/pi-process-fixtures.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeSupervisor implements PiProcessSupervisor {
  public lastSpec?: PiLaunchSpec;
  public record?: PiProcessRecord;
  public exit?: PiProcessExit;

  async launch(spec: PiLaunchSpec): Promise<PiProcessRecord> {
    this.lastSpec = spec;
    this.record = processRecord({
      attemptId: spec.attemptId,
      attemptToken: spec.attemptToken,
      executable: spec.executable,
      cwd: spec.cwd,
      sessionId: spec.sessionId,
      sessionDir: spec.sessionDir,
      eventsPath: join(spec.sessionDir, "events.jsonl"),
      stderrPath: join(spec.sessionDir, "stderr.log"),
      recordPath: join(spec.sessionDir, "process.json"),
    });
    return this.record;
  }

  async observe(record: PiProcessRecord) {
    return this.exit === undefined
      ? { status: "running" as const, record }
      : { status: "exited" as const, exit: this.exit };
  }

  async wait(): Promise<PiProcessExit> {
    if (this.exit === undefined) throw new Error("fixture has not completed");
    return this.exit;
  }

  async cancel(record: PiProcessRecord) {
    return { attemptId: record.attemptId, signals: ["SIGINT" as const], exit: this.exit ?? null };
  }
}

for (const family of ["codex", "devin", "claude"] as const) {
  describe(`Pi ${family} profile contract`, () => {
    it("runs through the same Pi runtime", async () => {
      const root = await mkdtemp(join(tmpdir(), `harness-pi-${family}-`));
      temporary.push(root);
      const worktree = join(root, "worktree");
      await mkdir(worktree);
      const assignment = contractAssignment({
        workerKind: family,
        worktree: {
          role: "implementation",
          path: worktree,
          branch: `harness/${family}`,
          commit: "abc123",
          writable: true,
        },
      });
      const supervisor = new FakeSupervisor();
      const profiles = fixtureResolvedProfiles();
      const runtime = new PiWorkerRuntime({
        profiles,
        managedProfiles: Object.fromEntries(Object.keys(profiles.byId).map((id) => [id, {
          extensionPaths: profiles.byId[id]!.extensions,
          piSkillPaths: profiles.byId[id]!.skills.filter((skill) => skill.targets.includes("pi")).map((skill) => skill.path),
          providerSkillPaths: [],
          promptTemplatePaths: [],
          environment: { HOME: join(root, "home"), PATH: "/usr/bin:/bin" },
          receiptHash: `sha256:${"a".repeat(64)}`,
        }])),
        supervisor,
        piExecutable: "/managed/bin/pi",
        transportExtensionPath: "/managed/harness/worker-transport.js",
      });

      const prepared = await runtime.prepare(assignment);
      const handle = await runtime.launch(prepared);
      await writeFile(prepared.resultPath, completedResultText(assignment));
      supervisor.exit = {
        exitCode: 0,
        signal: null,
        terminal: {
          settled: true,
          acceptedStopReason: true,
          completeToolResults: true,
          finalAssistantText: completedResultText(assignment),
        },
      };

      await expect(runtime.collect(prepared)).resolves.toMatchObject({ status: "valid" });
      expect(handle.process).toBe(supervisor.record);
      expect(supervisor.lastSpec?.executable).toBe("/managed/bin/pi");
      expect(supervisor.lastSpec?.argv).toContain("json");
      expect(await readFile(join(worktree, ".harness-output", "assignment.md"), "utf8"))
        .toContain(assignment.assignmentHash);
    });
  });
}
