import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HarnessEvent } from "../../../src/contracts/events.js";
import {
  buildHandoffReport,
  maxHandoffReportBytes,
  verifyHandoffReport,
  writeHandoffReport,
} from "../../../src/runtime/workers/handoff-report.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function event(sequence: number, entityId: string, eventType: string, payload: unknown): HarnessEvent {
  return { sequence, entityId, eventType, payload } as HarnessEvent;
}

const hash = `sha256:${"a".repeat(64)}` as const;

it("builds one task report from accepted commits, findings, and verification evidence", () => {
  const events = [
    event(1, "implement:T001", "worker.result_observed", {
      outcome: "completed", role: "implementation", commit: "commit-1",
      evidence: [{ kind: "test", path: "logs/unit.txt", sha256: hash }],
    }),
    event(2, "review:T001", "review.changes_requested", {
      commit: "commit-1", findings: ["Parser fails on Unicode"], reviewer: "reviewer",
    }),
    event(3, "verify:T001", "verification.failed", {
      commit: "commit-1", evidence: ["unit test failed"],
    }),
    event(4, "implement:T001", "worker.result_observed", {
      outcome: "completed", role: "implementation", commit: "commit-2",
      evidence: [{ kind: "test", path: "logs/retry.txt", sha256: hash }],
    }),
    event(5, "implement:T002", "worker.result_observed", {
      outcome: "completed", role: "implementation", commit: "other-task", evidence: [],
    }),
  ];
  const built = buildHandoffReport(events, "T001");
  expect(built.report.previousCommit).toBe("commit-2");
  expect(built.report.implementations.map((item) => item.commit)).toEqual(["commit-1", "commit-2"]);
  expect(built.report.reviews[0]?.findings).toEqual(["Parser fails on Unicode"]);
  expect(built.report.verifications).toEqual([{ commit: "commit-1", passed: false, evidence: ["unit test failed"] }]);
  expect(JSON.stringify(built.report)).not.toContain("other-task");
});

it("writes a private hash-checked report and rejects tampering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-report-"));
  dirs.push(dir);
  const path = join(dir, "handoff.json");
  const built = buildHandoffReport([event(1, "implement:T001", "worker.result_observed", {
    outcome: "completed", role: "implementation", commit: "commit-1", evidence: [],
  })], "T001");
  await writeHandoffReport(path, built);
  expect((await verifyHandoffReport(path, built.hash)).previousCommit).toBe("commit-1");
  await writeFile(path, (await readFile(path, "utf8")).replace("commit-1", "commit-2"));
  await expect(verifyHandoffReport(path, built.hash)).rejects.toThrow("handoff_report_corrupt");
});

it("blocks a report larger than 1 MiB without dropping findings", () => {
  expect(() => buildHandoffReport([
    event(1, "implement:T001", "worker.result_observed", {
      outcome: "completed", role: "implementation", commit: "commit-1", evidence: [],
    }),
    event(2, "review:T001", "review.changes_requested", {
      commit: "commit-1", findings: ["x".repeat(maxHandoffReportBytes)], reviewer: "reviewer",
    }),
  ], "T001")).toThrow("handoff_report_oversize");
});
