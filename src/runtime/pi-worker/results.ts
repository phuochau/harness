import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkerAssignment } from "../../core/assignment.js";
import type { WorkerResult } from "../../contracts/worker-result.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { sha256 } from "../../shared/sha256.js";
import type { PiTerminalBoundary } from "../pi-process/types.js";
import { parseWorkerResult } from "../workers/result.js";
import type { ParsedWorkerResult } from "../workers/types.js";

function validateCandidate(
  parsed: ParsedWorkerResult,
  assignment: WorkerAssignment,
): ParsedWorkerResult {
  if (
    parsed.status === "valid" &&
    parsed.result.outcome !== "blocked" &&
    parsed.result.outcome !== "failed" &&
    parsed.result.role === "review" &&
    parsed.result.reviewedCommit !== assignment.commit
  ) {
    return { status: "invalid", reason: "reviewed commit does not match assignment" };
  }
  return parsed;
}

function unwrapResult(raw: string): string {
  const start = "HARNESS_REVIEW_RESULT_V1 ";
  const end = "HARNESS_REVIEW_RESULT_END_V1";
  const normalized = raw.replace(/\r\n/g, "\n");
  const marker = normalized.lastIndexOf(`\n${start}`) + 1;
  const startsAtBeginning = normalized.startsWith(start);
  const offset = startsAtBeginning ? 0 : marker;
  if (
    offset >= 0 &&
    normalized.indexOf(start) === offset &&
    normalized.indexOf(start, offset + start.length) === -1
  ) {
    const finish = normalized.indexOf(`\n${end}`, offset + start.length);
    if (
      finish >= 0 &&
      normalized.slice(finish + end.length + 1).trim() === "" &&
      finish - (offset + start.length) <= 256 * 1024
    ) {
      return normalized.slice(offset + start.length, finish);
    }
  }
  return raw.trim();
}

export function parseTerminalWorkerResult(
  raw: string,
  assignment: WorkerAssignment,
  terminal: PiTerminalBoundary,
): ParsedWorkerResult {
  if (!terminal.settled || !terminal.acceptedStopReason || !terminal.completeToolResults) {
    return {
      status: "invalid",
      reason: "Pi process did not reach a valid terminal boundary",
    };
  }
  const unwrapped = unwrapResult(raw);
  let candidate = unwrapped;
  try {
    const envelope: unknown = JSON.parse(unwrapped);
    if (
      typeof envelope === "object" && envelope !== null && !Array.isArray(envelope) &&
      "result" in envelope
    ) {
      candidate = JSON.stringify((envelope as { result: unknown }).result);
    }
  } catch {
    // parseWorkerResult returns the stable JSON diagnostic.
  }
  return validateCandidate(parseWorkerResult(candidate, assignment), assignment);
}

interface TranscriptEvidence {
  readonly kind: string;
  readonly content: string;
}

async function materializeReviewEnvelope(
  raw: string,
  resultPath: string,
  assignment: WorkerAssignment,
): Promise<string> {
  const framed = unwrapResult(raw);
  let envelope: unknown;
  try {
    envelope = JSON.parse(framed);
  } catch {
    return raw;
  }
  if (
    typeof envelope !== "object" || envelope === null || Array.isArray(envelope) ||
    !("result" in envelope) || !("evidence" in envelope)
  ) return raw;
  const value = envelope as { result: unknown; evidence: unknown };
  if (!Array.isArray(value.evidence) || value.evidence.length > 32) return raw;
  if (
    typeof value.result !== "object" || value.result === null || Array.isArray(value.result) ||
    (value.result as { assignmentHash?: unknown }).assignmentHash !== assignment.assignmentHash
  ) return raw;
  const validatedEvidence: TranscriptEvidence[] = [];
  for (const item of value.evidence) {
    if (
      typeof item !== "object" || item === null || Array.isArray(item) ||
      typeof (item as TranscriptEvidence).kind !== "string" ||
      (item as TranscriptEvidence).kind.length === 0 ||
      typeof (item as TranscriptEvidence).content !== "string" ||
      (item as TranscriptEvidence).content.length > 1024 * 1024
    ) return raw;
    validatedEvidence.push(item as TranscriptEvidence);
  }
  const outputDirectory = dirname(resultPath);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputInfo = await lstat(outputDirectory);
  if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
    throw new Error("worker result output directory is not a real directory");
  }
  const evidence = [];
  for (const [index, typed] of validatedEvidence.entries()) {
    const name = `pi-evidence-${index + 1}.txt`;
    await writeFile(join(outputDirectory, name), typed.content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    evidence.push({
      kind: typed.kind,
      path: `.harness-output/${name}`,
      sha256: sha256(typed.content),
    });
  }
  const result = { ...(value.result as Record<string, unknown>), evidence };
  const parsed = validateCandidate(parseWorkerResult(JSON.stringify(result), assignment), assignment);
  if (parsed.status !== "valid") return raw;
  await writeFile(resultPath, `${canonicalJson(parsed.result)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return JSON.stringify(parsed.result);
}

export async function collectPiWorkerResult(input: {
  readonly assignment: WorkerAssignment;
  readonly resultPath: string;
  readonly terminal: PiTerminalBoundary;
}): Promise<ParsedWorkerResult> {
  let raw: string | undefined;
  try {
    const info = await lstat(input.resultPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
      return { status: "invalid", reason: "worker result is not a bounded regular file" };
    }
    raw = await readFile(input.resultPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw === undefined && input.terminal.finalAssistantText !== undefined) {
    raw = await materializeReviewEnvelope(
      input.terminal.finalAssistantText,
      input.resultPath,
      input.assignment,
    );
  }
  if (raw === undefined) {
    return { status: "invalid", reason: "worker produced no structured result" };
  }
  return parseTerminalWorkerResult(raw, input.assignment, input.terminal);
}

export function resultFromParsed(parsed: ParsedWorkerResult): WorkerResult | undefined {
  return parsed.status === "valid" ? parsed.result : undefined;
}
