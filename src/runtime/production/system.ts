import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EffectExecutor } from "../../actions/executor.js";
import type {
  ActionDependencies,
  ApprovalStore,
  Clock,
  ProcessRunner,
} from "../../actions/types.js";
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
import { createProductionActionRegistry } from "./action-registry.js";
import { recoverCleanupFailures } from "./cleanup-recovery.js";
import type { ProductionWorkerRuntime } from "./worker-action.js";
import type { PiWorkerRuntime } from "../pi-worker/runtime.js";
import { ProductionPiWorkerRuntime } from "./pi-worker.js";
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
import { join } from "node:path";
import type { PlanningAgent } from "../../ports/planning.js";
import type { ManagedPiRuntimeBundle } from "../managed/factory.js";
import { ChildPiPlanningPort, RoutedChildPiPlanningPort } from "../../pi/child-planning-port.js";

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
  readonly workerRuntime?: ProductionWorkerRuntime;
  readonly piWorkerRuntime?: PiWorkerRuntime;
  readonly managedPiRuntime?: ManagedPiRuntimeBundle;
  readonly process?: ProcessRunner;
  readonly planningAgent?: PlanningAgent;
}

export interface StandaloneProductionEffects {
  readonly effects: DurableEffectPort;
  dispose(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };

interface PersistedApproval {
  readonly approved: boolean;
  readonly actor: string;
  readonly recordedAt: string;
}

class DurableInteractiveApprovalStore implements ApprovalStore {
  private readonly prompts = new Map<string, Promise<PersistedApproval>>();

  public constructor(
    private readonly records: DurableRecordStore,
    private readonly context?: ExtensionContext,
    private readonly planPath?: string,
  ) {}

  public async get(requestId: string): Promise<PersistedApproval | undefined> {
    const existing = await this.records.get<PersistedApproval>("human-approval", requestId);
    if (existing !== undefined || this.context?.hasUI !== true) return existing;
    const pending = this.prompts.get(requestId);
    if (pending !== undefined) return pending;
    const prompt = (async () => {
      const approved = await this.context!.ui.confirm(
        "Approve Spec Kit plan?",
        this.planPath === undefined
          ? "Approve the sealed plan before implementation starts."
          : `Review ${this.planPath}, then approve implementation.`,
      );
      return this.records.put("human-approval", requestId, {
        approved,
        actor: "pi-operator",
        recordedAt: new Date().toISOString(),
      });
    })();
    this.prompts.set(requestId, prompt);
    try {
      return await prompt;
    } finally {
      this.prompts.delete(requestId);
    }
  }
}

const unavailableWorkerRuntime: ProductionWorkerRuntime = {
  async prepare() { throw new Error("managed Pi worker runtime is not configured"); },
  async execute() { throw new Error("managed Pi worker runtime is not configured"); },
  async reconcile() {
    return { status: "indeterminate", evidence: ["managed Pi worker runtime is not configured"] };
  },
};

function managedPlanningAgent(input: {
  readonly workflow: CompiledWorkflow;
  readonly runtime: ManagedPiRuntimeBundle;
  readonly root: string;
  readonly sessionRoot: string;
  readonly sealer: ProductionPlanningArtifactSealer;
}): PlanningAgent {
  const routes: Record<string, string> = {};
  const ports: Record<string, ChildPiPlanningPort> = {};
  for (const stage of input.workflow.stages.filter((stage) => stage.uses.startsWith("spec-kit."))) {
    const runner = stage.runner;
    const profileId = typeof runner === "string" ? runner : runner?.prefer[0];
    if (profileId === undefined) throw new Error(`planning stage ${stage.id} has no profile`);
    routes[stage.uses.slice("spec-kit.".length)] = profileId;
    if (ports[profileId] !== undefined) continue;
    const profile = input.workflow.profiles.byId[profileId];
    const managed = input.runtime.managedProfiles[profileId];
    if (profile === undefined || managed === undefined) {
      throw new Error(`managed planning profile is unavailable: ${profileId}`);
    }
    ports[profileId] = new ChildPiPlanningPort({
      root: input.root,
      profile,
      managed,
      supervisor: input.runtime.supervisor,
      piExecutable: input.runtime.piExecutable,
      piExecutableArgs: input.runtime.piExecutableArgs,
      transportExtensionPath: input.runtime.transportExtensionPath,
      sessionRoot: input.sessionRoot,
      sealer: input.sealer,
    });
  }
  return new RoutedChildPiPlanningPort(routes, ports);
}

export async function composeProductionRun(
  options: ComposeProductionRunOptions,
): Promise<ProductionRunSystem> {
  const { initialized, workflow } = options;
  const lease = await RunLease.acquire(
    initialized.paths,
    options.ownerId ?? `pi-${process.pid}-${crypto.randomUUID()}`,
  );
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
    const sealer = new ProductionPlanningArtifactSealer(
      initialized.manifest,
      planningBinding,
      worktrees,
      git,
    );
    let planning = options.planningAgent;
    if (planning === undefined && options.managedPiRuntime !== undefined) {
      planning = managedPlanningAgent({
        workflow,
        runtime: options.managedPiRuntime,
        root: planningBinding.path,
        sessionRoot: join(initialized.paths.workers, initialized.manifest.runId, "planning-sessions"),
        sealer,
      });
    }
    if (planning === undefined) {
      const planningPort = new PiSessionPlanningPort(options.pi, options.context);
      const planningProfile = new PlanningProfileCoordinator(
        new PiSessionModelPort(options.pi, options.context),
        new PiSessionPlanningProfileStore(options.context),
      );
      planning = new PlanningAction({
        root: planningBinding.path,
        correlation: new PiPlanningCorrelation(planningPort, planningProfile),
        sealer,
      });
    }
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
      profiles: workflow.profiles,
    });
    const effectivePiRuntime = options.piWorkerRuntime ?? options.managedPiRuntime?.workerRuntime;
    const workerRuntime = options.workerRuntime ?? (
      effectivePiRuntime === undefined
        ? unavailableWorkerRuntime
        : new ProductionPiWorkerRuntime({
            runtime: effectivePiRuntime,
            profiles: workflow.profiles,
            attempts,
            records,
          })
    );
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
      process: options.process ?? new NodeProcessRunner(),
      git,
      approvals: new DurableInteractiveApprovalStore(
        records,
        options.context,
        initialized.manifest.artifactPaths.plan,
      ),
      clock: systemClock,
      signal: abort.signal,
    };
    const executor = new EffectExecutor(registry, dependencies);
    const recoverCleanups = () => recoverCleanupFailures(
      records,
      (intent) => executor.retryCleanup(intent),
      (prepared, intent) => workerRuntime.abort!(prepared, intent as never),
    );
    const composed = createHarnessSystem({
      runId: initialized.manifest.runId,
      workflowRevision: workflow.revision,
      journal,
      lease,
      clock: systemClock,
      derive: createWorkflowCommandDeriver({ workflow, graph: () => currentGraph }),
      effects: executor,
      lifecycle: createWorkflowLifecycle(),
      beforeLeaseRelease: async () => {
        await recoverCleanups();
        await worktrees.cleanupAll();
      },
    });
    system = composed;
    return Object.freeze({
      controller: composed.controller,
      readState: composed.readState,
      async recover() {
        await recoverCleanups();
        await composed.recover();
      },
      async drain() {
        await composed.drain();
        await recoverCleanups();
        // A deferred worker effect stays outstanding until its durable cleanup
        // succeeds. Reconcile it in the same resident turn so downstream work
        // cannot race the repaired worktree ownership boundary.
        await composed.recover();
        await composed.drain();
      },
      graph: () => currentGraph,
      async dispose() {
        abort.abort();
        await composed.dispose();
      },
    });
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
}

export async function createStandaloneProductionEffects(input: {
  readonly root: string;
  readonly runId: string;
  readonly workflow: CompiledWorkflow;
  readonly commands: Readonly<Record<string, readonly string[]>>;
  readonly workerRuntime?: ProductionWorkerRuntime;
  readonly piWorkerRuntime?: PiWorkerRuntime;
  readonly managedPiRuntime?: ManagedPiRuntimeBundle;
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
  const records = new DurableRecordStore(paths.artifacts);
  const attempts = new GitWorkerAttemptPort({
    manifest,
    repository,
    worktrees,
    records,
    graph: () => graph,
    readState,
    taskVerification: [input.commands.task_verify ?? []].filter((argv) => argv.length > 0),
    profiles: input.workflow.profiles,
  });
  const effectivePiRuntime = input.piWorkerRuntime ?? input.managedPiRuntime?.workerRuntime;
  const workerRuntime = input.workerRuntime ?? (
    effectivePiRuntime === undefined
      ? unavailableWorkerRuntime
      : new ProductionPiWorkerRuntime({
          runtime: effectivePiRuntime,
          profiles: input.workflow.profiles,
          attempts,
          records,
        })
  );
  const planningSealer = new ProductionPlanningArtifactSealer(
    manifest,
    planningBinding,
    worktrees,
    git,
  );
  const planning: PlanningAgent = input.managedPiRuntime === undefined
    ? {
        enqueue: async () => {
          throw new Error("standalone recovery cannot dispatch a Pi planning turn");
        },
        observe: async () => ({
          status: "blocked" as const,
          reason: "standalone recovery requires the managed Pi planning runtime",
          evidence: [manifest.runId],
        }),
      }
    : managedPlanningAgent({
        workflow: input.workflow,
        runtime: input.managedPiRuntime,
        root: planningBinding.path,
        sessionRoot: join(paths.workers, manifest.runId, "planning-sessions"),
        sealer: planningSealer,
      });
  const registry = createProductionActionRegistry({
    manifest,
    repository,
    worktrees,
    records,
    readState,
    tasksSemanticHash: () => graph.graph.tasksSemanticHash,
    planningRoot: planningBinding.path,
    planning,
    workerRuntime,
    verificationObservations: new JournalVerificationObservations(journal),
  });
  const abort = new AbortController();
  const executor = new EffectExecutor(registry, {
    process: new NodeProcessRunner(),
    git,
    approvals: new DurableInteractiveApprovalStore(records),
    clock: systemClock,
    signal: abort.signal,
  });
  await recoverCleanupFailures(
    records,
    (intent) => executor.retryCleanup(intent),
    (prepared, intent) => workerRuntime.abort!(prepared, intent as never),
  );
  return {
    effects: executor,
    async dispose() {
      abort.abort();
      // The recovery command's fenced lease is released by recoverRun before
      // this transport is disposed. Per-effect cleanup already ran while the
      // lease was held; a global worktree sweep here could race a newly
      // acquired resident controller.
    },
  };
}
