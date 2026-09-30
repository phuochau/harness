import { expect, it } from "vitest";
import { compileWorkflow } from "../../../src/config/compile.js";
import { validateTaskGraph } from "../../../src/contracts/task-graph.js";
import type { ProfileCapabilities } from "../../../src/runtime/pi-worker/runtime.js";
import { initializeProductionRun } from "../../../src/runtime/production/run.js";
import {
  composeProductionRun,
  probeTieredRunnerCapabilities,
} from "../../../src/runtime/production/system.js";
import { canonicalJson } from "../../../src/shared/canonical-json.js";
import { parseSpecKitTasks } from "../../../src/speckit/task-records.js";
import { semanticHash } from "../../../src/speckit/semantic-hash.js";
import { Journal } from "../../../src/state/journal.js";
import { readRunManifest } from "../../../src/state/run-manifest.js";
import { createTempGitRepository } from "../../support/git-fixtures.js";
import {
  exactTaskDocumentV2Fixture,
} from "../../support/planning-fixtures.js";
import { fixtureCompileInput, fixtureResolvedProfiles } from "../../support/factories.js";

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

function tieredWorkflow() {
  return compileWorkflow({
    environment: {
      schema: "harness/environment/v1",
      commands: {},
      pi_packages: [],
    },
    profiles: fixtureResolvedProfiles(),
    workflow: {
      schema: "harness/v1",
      name: "tiered",
      stages: [{
        id: "implement",
        uses: "worker.execute",
        runner: {
          by_complexity: {
            mechanical: ["implementer-claude"],
            standard: ["implementer-codex"],
            complex: ["implementer-devin"],
          },
        },
        foreach: { source: "stages.tasks.outputs.graph", key: "task.id" },
        gate: "task.dependencies_done",
      }],
    },
  });
}

function probeResult(available: boolean): ProfileCapabilities {
  return {
    available,
    providerRegistered: true,
    modelAvailable: available,
    authenticated: available,
    resourcesVerified: true,
    evidence: [
      available
        ? "managed profile resources verified"
        : "authentication not ready",
    ],
  };
}

it("probes each declared tier profile once and freezes only bounded evidence", async () => {
  const probed: string[] = [];
  const snapshot = await probeTieredRunnerCapabilities({
    workflow: tieredWorkflow(),
    probe: async (profile) => {
      probed.push(profile.id);
      return {
        ...probeResult(profile.id === "implementer-devin"),
        apiKey: "sk-must-not-persist",
        prompt: "implement everything",
      } as unknown as ProfileCapabilities;
    },
  });
  expect(probed.sort()).toEqual([
    "implementer-claude",
    "implementer-codex",
    "implementer-devin",
  ]);
  expect(snapshot).toEqual({
    "implementer-claude": {
      available: false,
      evidence: ["authentication not ready"],
    },
    "implementer-codex": {
      available: false,
      evidence: ["authentication not ready"],
    },
    "implementer-devin": {
      available: true,
      evidence: ["managed profile resources verified"],
    },
  });
});

it("records a failed capability probe as unavailable instead of aborting run creation", async () => {
  const snapshot = await probeTieredRunnerCapabilities({
    workflow: tieredWorkflow(),
    probe: async (profile) => {
      if (profile.id === "implementer-codex") {
        throw new Error("spawn pi ENOENT");
      }
      return probeResult(true);
    },
  });
  expect(snapshot?.["implementer-codex"]).toMatchObject({ available: false });
  expect(snapshot?.["implementer-codex"]?.evidence.join(" ")).toContain(
    "ENOENT",
  );
  expect(snapshot?.["implementer-devin"]).toMatchObject({ available: true });
});

it("leaves the capability snapshot unset when no stage declares tiered runners", async () => {
  const snapshot = await probeTieredRunnerCapabilities({
    workflow: compileWorkflow(fixtureCompileInput()),
    probe: async () => {
      throw new Error("capability probe must not run");
    },
  });
  expect(snapshot).toBeUndefined();
});

it("routes implementation from the frozen capability snapshot on a production run", async () => {
  const tasksText = exactTaskDocumentV2Fixture();
  const records = parseSpecKitTasks(tasksText);
  const graphDocument = validateTaskGraph({
    schema: "harness/task-graph/v2",
    tasksSemanticHash: semanticHash(records),
    tasks: structuredClone([...records]),
  });
  const repo = await createTempGitRepository("tiered run", {
    "specs/feature/spec.md":
      "# Spec\n\n- FR-001: Parser behavior\n- SC-001: Parser verification\n",
    "specs/feature/plan.md": "# Plan\n\nUse a deterministic parser.\n",
    "specs/feature/tasks.md": tasksText,
    "specs/feature/task-graph.json": `${canonicalJson(graphDocument)}\n`,
  });
  let system: Awaited<ReturnType<typeof composeProductionRun>> | undefined;
  try {
    const workflow = tieredWorkflow();
    const artifacts = {
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
      artifactPaths: artifacts,
      remote: "origin",
      baseBranch: "main",
    });
    const dispatched: string[] = [];
    system = await composeProductionRun({
      initialized,
      workflow,
      artifactPaths: artifacts,
      commands: {},
      pi: { appendEntry() {}, sendUserMessage() {} } as any,
      context: {
        isIdle: () => true,
        sessionManager: {
          getSessionFile: () => undefined,
          getLeafId: () => null,
          getBranch: () => [],
        },
      } as any,
      workerRuntime: {
        async prepare(intent) {
          dispatched.push(String(intent.input.worker));
          return {};
        },
        async execute() {
          return {
            schemaVersion: 1 as const,
            assignmentHash: `sha256:${"d".repeat(64)}` as const,
            outcome: "blocked" as const,
            blocker: {
              reason: "fixture stop",
              evidence: ["fixture"],
              suggestedChange: "none",
            },
          };
        },
        async reconcile() {
          return { status: "indeterminate" as const, evidence: ["fixture"] };
        },
      },
      profileCapabilities: {
        "implementer-claude": {
          available: true,
          evidence: ["managed profile resources verified"],
        },
        "implementer-codex": {
          available: false,
          evidence: ["authentication not ready"],
        },
        "implementer-devin": {
          available: true,
          evidence: ["managed profile resources verified"],
        },
      },
    });
    await system.controller.enqueue({
      schemaVersion: 1,
      source: "timer",
      kind: "tick",
      idempotencyKey: "tick:start",
      payload: {},
    });
    await system.drain();
    expect(dispatched).toEqual(["implementer-devin"]);
    const events = await new Journal(initialized.paths).read();
    const routed = events.find(
      (event) =>
        event.eventType === "worker.routed" &&
        event.entityId === "implement:T001",
    );
    expect(routed?.payload).toMatchObject({
      worker: "implementer-devin",
      cause: "initial",
      tier: "complex",
      complexity: "standard",
      complexityReason: "Touches parser and CLI contract",
      taskId: "T001",
      fixRound: 0,
      workflowRevision: workflow.revision,
      tasksSemanticHash: graphDocument.tasksSemanticHash,
    });
    const state = await system.readState();
    expect(state.jobs["implement:T001"]?.route).toMatchObject({
      profileId: "implementer-devin",
      tier: "complex",
      cause: "initial",
    });
    expect(state.jobs["implement:T002"]?.state ?? "PENDING").toBe("PENDING");
  } finally {
    await system?.dispose();
    await repo.cleanup();
  }
});
