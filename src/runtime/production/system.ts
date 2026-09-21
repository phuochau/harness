import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EffectExecutor } from "../../actions/executor.js";
import type { ActionDependencies, Clock } from "../../actions/types.js";
import type { CompiledWorkflow } from "../../config/compile.js";
import { createWorkflowCommandDeriver, emptyTaskGraph } from "../../core/workflow-engine.js";
import { createWorkflowLifecycle } from "../../core/workflow-lifecycle.js";
import type { ValidatedTaskGraph } from "../../core/task-graph.js";
import { createHarnessSystem, type DurableHarnessSystem } from "../../durable-composition-root.js";
import { NativeGitActionPort } from "../../git/action-port.js";
import { NodeProcessRunner } from "../../git/process.js";
import { WorktreeLifecycle } from "../../git/workspace-lifecycle.js";
import { PiPlanningCorrelation } from "../../pi/planning-agent.js";
import { PiSessionPlanningPort } from "../../pi/planning-port.js";
import { PlanningProfileCoordinator } from "../../pi/planning-profile.js";
import {
  PiSessionModelPort,
  PiSessionPlanningProfileStore,
} from "../../pi/planning-profile-port.js";
import { PlanningAction } from "../../speckit/planning-action.js";
import type { ArtifactPaths } from "../../speckit/artifacts.js";
import { Journal } from "../../state/journal.js";
import { RunLease } from "../../state/lease.js";
import { connectInstalledHerdr, type HerdrClient } from "../herdr/client.js";
import { HerdrRuntime } from "../herdr/runtime.js";
import { workerAdapters } from "../workers/index.js";
import { createProductionActionRegistry } from "./action-registry.js";
import { HerdrProductionWorkerRuntime } from "./herdr-worker.js";
import { JournalVerificationObservations } from "./journal-observations.js";
import { loadRunTaskGraph, ProductionPlanningArtifactSealer } from "./planning-artifacts.js";
import { DurableRecordStore } from "./records.js";
import type { InitializedProductionRun } from "./run.js";
import { GitWorkerAttemptPort } from "./worker-attempts.js";
import { resolveRunPaths } from "../../state/paths.js";
import { readRunManifest } from "../../state/run-manifest.js";
import { GitRepository } from "../../git/repository.js";
import { initialRunState } from "../../core/state.js";
import { reduceEvent } from "../../core/reducer.js";
import type { DurableEffectPort } from "../../durable-composition-root.js";

export interface ProductionRunSystem extends DurableHarnessSystem {
  readonly graph: () => ValidatedTaskGraph;
}

export interface ComposeProductionRunOptions {
  readonly initialized: InitializedProductionRun;
  readonly workflow: CompiledWorkflow;
  readonly artifactPaths: ArtifactPaths;
  readonly commands: Readonly<Record<string, readonly string[]>>;
  readonly pi: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly ownerId?: string;
  readonly ensureHerdr?: () => Promise<HerdrClient>;
}

export interface StandaloneProductionEffects {
  readonly effects: DurableEffectPort;
  dispose(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };

async function installedHerdrRunning(): Promise<boolean> {
  const process = new NodeProcessRunner();
  const result = await process.run("herdr", ["status", "--json"], { shell: false });
  if (result.exitCode !== 0) return false;
  try {
    return JSON.parse(result.stdout).server?.running === true;
  } catch {
    return false;
  }
}

export async function ensureInstalledHerdr(): Promise<HerdrClient> {
  if (!(await installedHerdrRunning())) {
    const child = spawn("herdr", ["server"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (!(await installedHerdrRunning())) {
      if (Date.now() >= deadline) throw new Error("Herdr server did not become ready");
      await delay(100);
    }
  }
  return connectInstalledHerdr();
}

export async function composeProductionRun(
  options: ComposeProductionRunOptions,
): Promise<ProductionRunSystem> {
  const { initialized, workflow } = options;
  const lease = await RunLease.acquire(
    initialized.paths,
    options.ownerId ?? `pi-${process.pid}-${crypto.randomUUID()}`,
  );
  let herdrClient: HerdrClient | undefined;
  try {
    const journal = new Journal(initialized.paths);
    if ((await journal.read()).length === 0) {
      await journal.append({
        schemaVersion: 1,
        timestamp: systemClock.now().toISOString(),
        runId: initialized.manifest.runId,
        entityId: `run:${initialized.manifest.runId}`,
        idempotencyKey: "run:create",
        eventType: "run.created",
        payload: { workflowRevision: workflow.revision },
      }, lease);
    }
    const git = new NativeGitActionPort(initialized.manifest.repositoryRoot);
    const worktrees = await WorktreeLifecycle.open({
      repository: initialized.repository,
      workspaceRoot: initialized.paths.workers,
    });
    const planningBinding = await worktrees.openPlanning({
      runId: initialized.manifest.runId,
      runBranch: initialized.manifest.planningRef.replace(/^refs\/heads\//, ""),
      artifactPaths: Object.values(options.artifactPaths),
    });
    let currentGraph = emptyTaskGraph();
    try {
      currentGraph = await loadRunTaskGraph(git, initialized.manifest);
    } catch {
      // A new run has no task graph until the correlated Spec Kit tasks stage seals it.
    }
    const planningPort = new PiSessionPlanningPort(options.pi, options.context);
    const planningProfile = new PlanningProfileCoordinator(
      new PiSessionModelPort(options.pi, options.context),
      new PiSessionPlanningProfileStore(options.context),
    );
    const planning = new PlanningAction({
      root: planningBinding.path,
      correlation: new PiPlanningCorrelation(planningPort, planningProfile),
      sealer: new ProductionPlanningArtifactSealer(
        initialized.manifest,
        planningBinding,
        worktrees,
        git,
      ),
    });
    herdrClient = await (options.ensureHerdr ?? ensureInstalledHerdr)();
    const records = new DurableRecordStore(initialized.paths.artifacts);
    let system: DurableHarnessSystem | undefined;
    const readState = async () => {
      if (system === undefined) throw new Error("production controller is not composed");
      return system.readState();
    };
    const attempts = new GitWorkerAttemptPort({
      manifest: initialized.manifest,
      repository: initialized.repository,
      worktrees,
      records,
      graph: () => currentGraph,
      readState,
      taskVerification: [options.commands.task_verify ?? []].filter((argv) => argv.length > 0),
    });
    const workerRuntime = new HerdrProductionWorkerRuntime({
      adapters: workerAdapters(),
      herdr: new HerdrRuntime(herdrClient),
      attempts,
    });
    const registry = createProductionActionRegistry({
      manifest: initialized.manifest,
      repository: initialized.repository,
      worktrees,
      records,
      readState,
      tasksSemanticHash: () => currentGraph.graph.tasksSemanticHash,
      planningRoot: planningBinding.path,
      planning,
      workerRuntime,
      verificationObservations: new JournalVerificationObservations(journal),
      afterPlanningCompleted: async (output) => {
        if (output.stage === "tasks") {
          currentGraph = await loadRunTaskGraph(git, initialized.manifest);
        }
      },
    });
    const abort = new AbortController();
    const dependencies: ActionDependencies = {
      process: new NodeProcessRunner(),
      git,
      approvals: { get: async () => undefined },
      clock: systemClock,
      signal: abort.signal,
    };
    const executor = new EffectExecutor(registry, dependencies);
    const composed = createHarnessSystem({
      runId: initialized.manifest.runId,
      workflowRevision: workflow.revision,
      journal,
      lease,
      clock: systemClock,
      derive: createWorkflowCommandDeriver({ workflow, graph: () => currentGraph }),
      effects: executor,
      lifecycle: createWorkflowLifecycle(),
    });
    system = composed;
    return Object.freeze({
      controller: composed.controller,
      readState: composed.readState,
      recover: composed.recover,
      drain: composed.drain,
      graph: () => currentGraph,
      async dispose() {
        abort.abort();
        try {
          await composed.dispose();
        } finally {
          herdrClient?.close();
          await worktrees.cleanupAll();
        }
      },
    });
  } catch (error) {
    herdrClient?.close();
    await lease.release().catch(() => undefined);
    throw error;
  }
}

export async function createStandaloneProductionEffects(input: {
  readonly root: string;
  readonly runId: string;
  readonly workflow: CompiledWorkflow;
  readonly commands: Readonly<Record<string, readonly string[]>>;
}): Promise<StandaloneProductionEffects> {
  const paths = await resolveRunPaths(input.root, input.runId);
  const manifest = await readRunManifest(paths.manifest);
  if (manifest.workflowRevision !== input.workflow.revision) {
    throw new Error("installed workflow revision does not match the durable run");
  }
  const repository = await GitRepository.open(manifest.repositoryRoot);
  const journal = new Journal(paths);
  const git = new NativeGitActionPort(manifest.repositoryRoot);
  const worktrees = await WorktreeLifecycle.open({
    repository,
    workspaceRoot: paths.workers,
  });
  const planningBinding = await worktrees.openPlanning({
    runId: manifest.runId,
    runBranch: manifest.planningRef.replace(/^refs\/heads\//, ""),
    artifactPaths: Object.values(manifest.artifactPaths),
  });
  let graph = emptyTaskGraph();
  try {
    graph = await loadRunTaskGraph(git, manifest);
  } catch {
    // Pending planning effects are deliberately unrecoverable without their Pi session.
  }
  const readState = async () => {
    let state = initialRunState(manifest.runId, manifest.workflowRevision);
    for (const event of await journal.read()) state = reduceEvent(state, event);
    return state;
  };
  const client = await ensureInstalledHerdr();
  const records = new DurableRecordStore(paths.artifacts);
  const attempts = new GitWorkerAttemptPort({
    manifest,
    repository,
    worktrees,
    records,
    graph: () => graph,
    readState,
    taskVerification: [input.commands.task_verify ?? []].filter((argv) => argv.length > 0),
  });
  const registry = createProductionActionRegistry({
    manifest,
    repository,
    worktrees,
    records,
    readState,
    tasksSemanticHash: () => graph.graph.tasksSemanticHash,
    planningRoot: planningBinding.path,
    planning: {
      enqueue: async () => {
        throw new Error("standalone recovery cannot dispatch a Pi planning turn");
      },
      observe: async () => ({
        status: "blocked",
        reason: "standalone recovery requires the original Pi session for planning",
        evidence: [manifest.runId],
      }),
    },
    workerRuntime: new HerdrProductionWorkerRuntime({
      adapters: workerAdapters(),
      herdr: new HerdrRuntime(client),
      attempts,
    }),
    verificationObservations: new JournalVerificationObservations(journal),
  });
  const abort = new AbortController();
  const executor = new EffectExecutor(registry, {
    process: new NodeProcessRunner(),
    git,
    approvals: { get: async () => undefined },
    clock: systemClock,
    signal: abort.signal,
  });
  return {
    effects: executor,
    async dispose() {
      abort.abort();
      client.close();
      await worktrees.cleanupAll();
    },
  };
}
