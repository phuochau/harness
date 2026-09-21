import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileRuntimeEvidence } from "../../../src/runtime/herdr/runtime.js";
import { sha256 } from "../../../src/shared/sha256.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

it("materializes a structured read-only review result from terminal output", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-result-"));
  temporary.push(root);
  const resultPath = join(root, ".harness-output", "result.json");
  const assignmentHash = `sha256:${"a".repeat(64)}`;
  const reviewedCommit = "b".repeat(40);
  const content = "Invoked requesting-code-review and verified the assigned commit.\n";
  const transcript = [
    "review complete",
    `HARNESS_REVIEW_RESULT_V1 ${JSON.stringify({
      result: {
        schemaVersion: 1,
        assignmentHash,
        role: "review",
        outcome: "approved",
        reviewedCommit,
        findings: [],
      },
      evidence: [{ kind: "superpower:requesting-code-review", content }],
    })}`,
    "HARNESS_REVIEW_RESULT_END_V1",
  ].join("\n");

  const result = await new FileRuntimeEvidence().materializeTranscriptResult(
    resultPath,
    transcript,
    assignmentHash,
  );

  expect(result).toMatchObject({
    assignmentHash,
    role: "review",
    outcome: "approved",
    reviewedCommit,
    evidence: [{
      kind: "superpower:requesting-code-review",
      path: ".harness-output/transcript-evidence-1.txt",
      sha256: sha256(content),
    }],
  });
  expect(await readFile(join(root, ".harness-output", "transcript-evidence-1.txt"), "utf8"))
    .toBe(content);
  expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(result);
});

it("ignores transcript envelopes for a different immutable assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-result-"));
  temporary.push(root);
  const transcript = `HARNESS_REVIEW_RESULT_V1 ${JSON.stringify({
    result: {
      schemaVersion: 1,
      assignmentHash: `sha256:${"b".repeat(64)}`,
      role: "review",
      outcome: "approved",
      reviewedCommit: "c".repeat(40),
      findings: [],
    },
    evidence: [],
  })}\nHARNESS_REVIEW_RESULT_END_V1`;

  await expect(new FileRuntimeEvidence().materializeTranscriptResult(
    join(root, ".harness-output", "result.json"),
    transcript,
    `sha256:${"a".repeat(64)}`,
  )).resolves.toBeUndefined();
});

it("reassembles a review envelope split by terminal soft wrapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-result-"));
  temporary.push(root);
  const assignmentHash = `sha256:${"a".repeat(64)}`;
  const envelope = JSON.stringify({
    result: {
      schemaVersion: 1,
      assignmentHash,
      role: "review",
      outcome: "approved",
      reviewedCommit: "c".repeat(40),
      findings: [],
    },
    evidence: [{
      kind: "superpower:requesting-code-review",
      content: "commands and observations",
    }],
  }).replace("commands and observations", "commands and \nobservations");

  const result = await new FileRuntimeEvidence().materializeTranscriptResult(
    join(root, ".harness-output", "result.json"),
    `review complete\nHARNESS_REVIEW_RESULT_V1 ${envelope}\nHARNESS_REVIEW_RESULT_END_V1`,
    assignmentHash,
  );

  expect(result).toMatchObject({
    assignmentHash,
    outcome: "approved",
    evidence: [expect.objectContaining({
      sha256: sha256("commands and observations"),
    })],
  });
});

it("waits for a transcript envelope that is still streaming", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-result-"));
  temporary.push(root);

  await expect(new FileRuntimeEvidence().materializeTranscriptResult(
    join(root, ".harness-output", "result.json"),
    'HARNESS_REVIEW_RESULT_V1 {"result":{"schemaVersion":1',
    `sha256:${"a".repeat(64)}`,
  )).resolves.toBeUndefined();
});

it("rejects a quoted or non-final review protocol block", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-result-"));
  temporary.push(root);
  const assignmentHash = `sha256:${"a".repeat(64)}`;
  const envelope = JSON.stringify({
    result: {
      schemaVersion: 1,
      assignmentHash,
      role: "review",
      outcome: "approved",
      reviewedCommit: "c".repeat(40),
      findings: [],
    },
    evidence: [],
  });
  const evidence = new FileRuntimeEvidence();
  await expect(evidence.materializeTranscriptResult(
    join(root, ".harness-output", "result.json"),
    `  HARNESS_REVIEW_RESULT_V1 ${envelope}\nHARNESS_REVIEW_RESULT_END_V1`,
    assignmentHash,
  )).resolves.toBeUndefined();
  await expect(evidence.materializeTranscriptResult(
    join(root, ".harness-output", "result.json"),
    `HARNESS_REVIEW_RESULT_V1 ${envelope}\nHARNESS_REVIEW_RESULT_END_V1\nmore output`,
    assignmentHash,
  )).resolves.toBeUndefined();
});

it("accepts only a shell prompt after the final review protocol block", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-result-"));
  temporary.push(root);
  const assignmentHash = `sha256:${"a".repeat(64)}`;
  const envelope = JSON.stringify({
    result: {
      schemaVersion: 1,
      assignmentHash,
      role: "review",
      outcome: "approved",
      reviewedCommit: "c".repeat(40),
      findings: [],
    },
    evidence: [],
  });
  await expect(new FileRuntimeEvidence().materializeTranscriptResult(
    join(root, ".harness-output", "result.json"),
    `hauvo@host attempt-1 % devin --print\nHARNESS_REVIEW_RESULT_V1 ${envelope}\nHARNESS_REVIEW_RESULT_END_V1\nhauvo@host attempt-1 %`,
    assignmentHash,
  )).resolves.toMatchObject({ assignmentHash, outcome: "approved" });
});

it("does not mistake arbitrary trailing agent prose for a shell prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-result-"));
  temporary.push(root);
  const assignmentHash = `sha256:${"a".repeat(64)}`;
  const envelope = JSON.stringify({
    result: {
      schemaVersion: 1,
      assignmentHash,
      role: "review",
      outcome: "approved",
      reviewedCommit: "c".repeat(40),
      findings: [],
    },
    evidence: [],
  });
  await expect(new FileRuntimeEvidence().materializeTranscriptResult(
    join(root, ".harness-output", "result.json"),
    `HARNESS_REVIEW_RESULT_V1 ${envelope}\nHARNESS_REVIEW_RESULT_END_V1\nstill validating >`,
    assignmentHash,
  )).resolves.toBeUndefined();
});

it("refuses to materialize review evidence through an output symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-transcript-result-"));
  const external = await mkdtemp(join(tmpdir(), "harness-transcript-external-"));
  temporary.push(root, external);
  await mkdir(root, { recursive: true });
  await symlink(external, join(root, ".harness-output"));
  const assignmentHash = `sha256:${"a".repeat(64)}`;
  const transcript = `HARNESS_REVIEW_RESULT_V1 ${JSON.stringify({
    result: {
      schemaVersion: 1,
      assignmentHash,
      role: "review",
      outcome: "approved",
      reviewedCommit: "c".repeat(40),
      findings: [],
    },
    evidence: [],
  })}\nHARNESS_REVIEW_RESULT_END_V1`;

  const evidence = new FileRuntimeEvidence();
  await expect(evidence.materializeTranscriptResult(
    join(root, ".harness-output", "result.json"),
    transcript,
    assignmentHash,
  )).rejects.toThrow(/output directory/);
  await expect(evidence.readResult(
    join(root, ".harness-output", "result.json"),
  )).rejects.toThrow(/output directory/);
});
