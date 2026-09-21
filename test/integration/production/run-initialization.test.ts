import { expect, it } from "vitest";
import { initializeProductionRun } from "../../../src/runtime/production/run.js";
import { readRunManifest } from "../../../src/state/run-manifest.js";
import { createTempGitRepository } from "../../support/git-fixtures.js";

it("freezes repository and approval identity before a production run", async () => {
  const fixture = await createTempGitRepository("production run");
  try {
    const initialized = await initializeProductionRun({
      root: fixture.path,
      runId: "F023",
      workflowRevision: `sha256:${"a".repeat(64)}`,
      approvedPreviewHash: `sha256:${"b".repeat(64)}`,
      artifactPaths: {
        spec: "specs/feature/spec.md",
        plan: "specs/feature/plan.md",
        tasks: "specs/feature/tasks.md",
        graph: "specs/feature/task-graph.json",
      },
      remote: "origin",
      baseBranch: "main",
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });
    expect(initialized.manifest).toMatchObject({
      frozenBase: fixture.initialCommit,
      runRef: "refs/heads/harness/run-F023",
      planningRef: "refs/heads/harness/plan-F023",
    });
    await expect(readRunManifest(initialized.paths.manifest)).resolves.toEqual(
      initialized.manifest,
    );
    await expect(fixture.repository.revParse(initialized.manifest.runRef))
      .resolves.toBe(fixture.initialCommit);
    await expect(fixture.repository.revParse(initialized.manifest.planningRef))
      .resolves.toBe(fixture.initialCommit);
  } finally {
    await fixture.cleanup();
  }
});

it("rejects a dirty repository before creating run branches", async () => {
  const fixture = await createTempGitRepository("dirty production run");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${fixture.path}/dirty.txt`, "dirty\n", "utf8");
    await expect(initializeProductionRun({
      root: fixture.path,
      runId: "F024",
      workflowRevision: `sha256:${"a".repeat(64)}`,
      approvedPreviewHash: `sha256:${"b".repeat(64)}`,
      artifactPaths: {
        spec: "specs/feature/spec.md",
        plan: "specs/feature/plan.md",
        tasks: "specs/feature/tasks.md",
        graph: "specs/feature/task-graph.json",
      },
      remote: "origin",
      baseBranch: "main",
    })).rejects.toThrow(/clean repository/);
    await expect(fixture.repository.revParseOptional("refs/heads/harness/run-F024"))
      .resolves.toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
});
