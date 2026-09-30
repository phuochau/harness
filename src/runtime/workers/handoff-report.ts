import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessEvent } from "../../contracts/events.js";
import { taskIdForJob } from "../../core/lifecycle.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { sha256 } from "../../shared/sha256.js";

export const maxHandoffReportBytes = 1024 * 1024;

export interface HandoffReport {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly previousCommit: string;
  readonly implementations: readonly {
    readonly commit: string;
    readonly evidence: readonly { readonly kind: string; readonly path: string; readonly sha256: string; readonly content?: string }[];
  }[];
  readonly reviews: readonly {
    readonly commit: string;
    readonly findings: readonly string[];
  }[];
  readonly verifications: readonly {
    readonly commit: string;
    readonly passed: boolean;
    readonly evidence: readonly string[];
  }[];
}

export interface BuiltHandoffReport {
  readonly report: HandoffReport;
  readonly hash: `sha256:${string}`;
  readonly bytes: number;
}

function reportBytes(report: HandoffReport): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(report)}\n`);
}

export function buildHandoffReport(events: readonly HarnessEvent[], taskId: string): BuiltHandoffReport {
  if (!/^T[0-9]{3,}$/.test(taskId)) throw new Error("invalid handoff task id");
  const implementations: HandoffReport["implementations"][number][] = [];
  const reviews: HandoffReport["reviews"][number][] = [];
  const verifications: HandoffReport["verifications"][number][] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (taskIdForJob(event.entityId) !== taskId) continue;
    if (event.eventType === "worker.result_observed") {
      const result = event.payload;
      if (result.outcome === "completed" && result.role === "implementation") {
        implementations.push({
          commit: result.commit,
          evidence: result.evidence.map(({ kind, path, sha256: hash }) => ({ kind, path, sha256: hash })),
        });
      }
    } else if (event.eventType === "review.changes_requested") {
      reviews.push({ commit: event.payload.commit, findings: [...event.payload.findings] });
    } else if (event.eventType === "verification.passed" || event.eventType === "verification.failed") {
      verifications.push({
        commit: event.payload.commit,
        passed: event.eventType === "verification.passed",
        evidence: [...event.payload.evidence],
      });
    }
  }
  const previousCommit = implementations.at(-1)?.commit;
  if (previousCommit === undefined) throw new Error(`task ${taskId} has no accepted implementation commit`);
  const report: HandoffReport = { schemaVersion: 1, taskId, previousCommit, implementations, reviews, verifications };
  const encoded = reportBytes(report);
  if (encoded.byteLength > maxHandoffReportBytes) throw new Error("handoff_report_oversize");
  return { report, hash: sha256(encoded), bytes: encoded.byteLength };
}

export async function buildVerifiedHandoffReport(
  events: readonly HarnessEvent[],
  taskId: string,
  evidenceRoot: string,
): Promise<BuiltHandoffReport> {
  const base = buildHandoffReport(events, taskId);
  const implementations = await Promise.all(base.report.implementations.map(async (implementation) => ({
    ...implementation,
    evidence: await Promise.all(implementation.evidence.map(async (item) => {
      if (!/^sha256:[0-9a-f]{64}$/.test(item.sha256)) throw new Error("handoff_report_corrupt_evidence");
      const path = join(evidenceRoot, item.sha256.slice(7));
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0 || info.size > maxHandoffReportBytes) {
        throw new Error("handoff_report_corrupt_evidence");
      }
      const bytes = await readFile(path);
      if (sha256(bytes) !== item.sha256) throw new Error("handoff_report_corrupt_evidence");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { ...item, content };
    })),
  })));
  const report: HandoffReport = { ...base.report, implementations };
  const encoded = reportBytes(report);
  if (encoded.byteLength > maxHandoffReportBytes) throw new Error("handoff_report_oversize");
  return { report, hash: sha256(encoded), bytes: encoded.byteLength };
}

export async function writeHandoffReport(path: string, built: BuiltHandoffReport): Promise<void> {
  const bytes = reportBytes(built.report);
  if (bytes.byteLength > maxHandoffReportBytes || sha256(bytes) !== built.hash) {
    throw new Error("handoff_report_corrupt");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await verifyHandoffReport(path, built.hash);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function verifyHandoffReport(path: string, expectedHash: `sha256:${string}`): Promise<HandoffReport> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0 || info.size > maxHandoffReportBytes) {
    throw new Error("handoff_report_corrupt");
  }
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedHash) throw new Error("handoff_report_corrupt");
  const report = JSON.parse(bytes.toString("utf8")) as HandoffReport;
  if (report.schemaVersion !== 1 || !/^T[0-9]{3,}$/.test(report.taskId) ||
      canonicalJson(report) + "\n" !== bytes.toString("utf8")) {
    throw new Error("handoff_report_corrupt");
  }
  return report;
}
