import { expect, it } from "vitest";
import { parseSpecKitTasks } from "../../../src/speckit/task-records.js";
import { semanticHash } from "../../../src/speckit/semantic-hash.js";
import {
  planningArtifactContract,
  validatePlanningArtifacts,
} from "../../../src/speckit/artifacts.js";
import {
  artifactPaths,
  emptyArtifactBaseline,
  planningProjectFixture,
  presetFixture,
} from "../../support/planning-fixtures.js";

it("wraps speckit.tasks and emits a controller-derived hash-bound graph", async () => {
  const preset = await presetFixture();
  expect(preset.manifest).toContain("strategy: wrap");
  expect(preset.command).toContain("{CORE_TEMPLATE}");
  expect(preset.command).toContain("harness-task-metadata:v1");
  expect(preset.command).toContain("controller derives both deterministically");

  const project = await planningProjectFixture();
  try {
    const artifacts = await validatePlanningArtifacts(
      project.root,
      planningArtifactContract("tasks", artifactPaths),
      emptyArtifactBaseline(),
    );
    expect(artifacts.graph?.schema).toBe("harness/task-graph/v1");
    expect(artifacts.graph?.tasksSemanticHash).toBe(
      semanticHash(parseSpecKitTasks(artifacts.files.tasks!.text)),
    );
  } finally {
    await project.cleanup();
  }
});

it.runIf(process.env.HARNESS_COMPAT_SPECKIT === "1")(
  "resolves through the installed Spec Kit CLI",
  async () => {
    // The release compatibility lane supplies an isolated config directory and
    // disposable Specify project before enabling this mutation-bearing smoke.
    const { runSpecKitCompatibilitySmoke } = await import(
      "../../../src/speckit/preset.js"
    );
    await expect(runSpecKitCompatibilitySmoke()).resolves.toBeUndefined();
  },
);

