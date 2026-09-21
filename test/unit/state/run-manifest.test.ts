import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  RunManifestMismatch,
  readRunManifest,
  writeRunManifest,
  type RunManifest,
} from "../../../src/state/run-manifest.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function manifest(root: string): RunManifest {
  return {
    schemaVersion: 1,
    runId: "F023",
    workflowRevision: `sha256:${"a".repeat(64)}`,
    repositoryRoot: root,
    repositoryIdentity: `sha256:${"b".repeat(64)}`,
    frozenBase: "c".repeat(40),
    runRef: "refs/heads/harness/run-F023",
    planningRef: "refs/heads/harness/plan-F023",
    artifactPaths: {
      spec: "specs/feature/spec.md",
      plan: "specs/feature/plan.md",
      tasks: "specs/feature/tasks.md",
      graph: "specs/feature/task-graph.json",
    },
    remote: "origin",
    baseBranch: "main",
    approvedPreviewHash: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-09-21T00:00:00.000Z",
  };
}

it("creates one immutable manifest and accepts an identical restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-manifest-"));
  temporary.push(root);
  const path = join(root, "run.json");
  const value = manifest(root);
  await expect(writeRunManifest(path, value)).resolves.toEqual(value);
  await expect(writeRunManifest(path, structuredClone(value))).resolves.toEqual(value);
  await expect(readRunManifest(path)).resolves.toEqual(value);
});

it("rejects a changed approval or repository identity on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-manifest-"));
  temporary.push(root);
  const path = join(root, "run.json");
  const value = manifest(root);
  await writeRunManifest(path, value);
  await expect(writeRunManifest(path, {
    ...value,
    approvedPreviewHash: `sha256:${"e".repeat(64)}`,
  })).rejects.toBeInstanceOf(RunManifestMismatch);
});

it("rejects artifact paths that can escape the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-manifest-"));
  temporary.push(root);
  await expect(writeRunManifest(join(root, "run.json"), {
    ...manifest(root),
    artifactPaths: { ...manifest(root).artifactPaths, tasks: "../tasks.md" },
  })).rejects.toThrow(/artifact path/);
});
