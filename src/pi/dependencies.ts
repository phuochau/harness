import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import type { ControllerCommand } from "../contracts/controller-command.js";
import { validateEnvironmentAndLock } from "../contracts/index.js";
import { compileWorkflow, type CompiledWorkflow } from "../config/compile.js";
import { loadEnvironment, loadWorkflow } from "../config/load.js";
import { ControllerCommandQueue } from "../controller/command-queue.js";
import { HarnessController } from "../controller/controller.js";
import {
  HarnessCommandService,
  type HarnessCommandBackend,
} from "./commands.js";
import type { HarnessRuntimeEventSink } from "./events.js";
import { ControllerEventRouter } from "./events.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { sha256 } from "../shared/sha256.js";
import { GitRepository } from "../git/repository.js";
import { initializeProductionRun } from "../runtime/production/run.js";
import {
  composeProductionRun,
  type ProductionRunSystem,
} from "../runtime/production/system.js";
import type { ArtifactPaths } from "../speckit/artifacts.js";

export interface HarnessSessionDependencies {
  readonly cwd: string;
  readonly sessionFile?: string;
  readonly commands?: HarnessCommandService;
  readonly events?: HarnessRuntimeEventSink;
  dispose(): Promise<void>;
}

export interface HarnessSessionDependencyFactory {
  create(context: ExtensionContext): Promise<HarnessSessionDependencies>;
}

export interface LazyExtensionDependencies {
  start(context: ExtensionContext): Promise<HarnessSessionDependencies>;
  current(): HarnessSessionDependencies | undefined;
  dispose(): Promise<void>;
}

const defaultFactory: HarnessSessionDependencyFactory = {
  async create(context) {
    const sessionFile = context.sessionManager.getSessionFile();
    return {
      cwd: context.cwd,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      async dispose() {},
    };
  },
};

interface LoadedProjectConfiguration {
  readonly workflow: CompiledWorkflow;
  readonly commands: Readonly<Record<string, readonly string[]>>;
  readonly permissions: readonly string[];
}

function artifactPaths(workflow: CompiledWorkflow): ArtifactPaths {
  const outputs = Object.assign(
    {},
    ...workflow.stages.map((stage) => stage.produces ?? {}),
  ) as Record<string, unknown>;
  for (const name of ["spec", "plan", "tasks", "graph"] as const) {
    if (typeof outputs[name] !== "string" || outputs[name].length === 0) {
      throw new Error(`workflow does not declare ${name} planning artifact`);
    }
  }
  return outputs as unknown as ArtifactPaths;
}

export function previewEffectKinds(
  stages: readonly { readonly uses: string }[],
): readonly string[] {
  return [...new Set(stages.map((stage) => stage.uses))];
}

async function loadProjectConfiguration(
  cwd: string,
): Promise<LoadedProjectConfiguration> {
  const harness = join(cwd, ".harness");
  const [workflowDocument, environment, lockText, policyText] = await Promise.all([
    loadWorkflow(join(harness, "workflow.yaml")),
    loadEnvironment(join(harness, "environment.yaml")),
    readFile(join(harness, "harness.lock"), "utf8"),
    readFile(join(harness, "policy.yaml"), "utf8"),
  ]);
  validateEnvironmentAndLock(environment, parse(lockText));
  const policy = parse(policyText) as { protected_paths?: unknown };
  const permissions = Array.isArray(policy.protected_paths)
    ? policy.protected_paths.filter((item): item is string => typeof item === "string")
    : [];
  return {
    workflow: compileWorkflow({ workflow: workflowDocument, environment }),
    commands: environment.commands,
    permissions,
  };
}

function customEntries(context: ExtensionContext, type: string) {
  return context.sessionManager.getBranch().flatMap((entry) =>
    entry.type === "custom" && entry.customType === type
      ? [{ id: entry.id, data: entry.data }]
      : [],
  );
}

function sessionController(
  pi: ExtensionAPI,
  context: ExtensionContext,
): HarnessController {
  let revision = customEntries(
    context,
    "harness:controller-command-processed",
  ).length;
  const queue = new ControllerCommandQueue<ControllerCommand>({
    accept: async (command) => {
      const existing = customEntries(context, "harness:controller-command").find(
        (entry) =>
          typeof entry.data === "object" &&
          entry.data !== null &&
          (entry.data as { idempotencyKey?: unknown }).idempotencyKey ===
            command.idempotencyKey,
      );
      if (!existing) pi.appendEntry("harness:controller-command", command);
      return { commandKey: command.idempotencyKey };
    },
    processReceived: async (commandKey) => {
      const processed = customEntries(
        context,
        "harness:controller-command-processed",
      ).some(
        (entry) =>
          typeof entry.data === "object" &&
          entry.data !== null &&
          (entry.data as { commandKey?: unknown }).commandKey === commandKey,
      );
      if (!processed) {
        revision += 1;
        pi.appendEntry("harness:controller-command-processed", {
          commandKey,
          stateRevision: revision,
        });
      }
      return { commandKey, stateRevision: revision };
    },
    pendingCommandKeysInSequenceOrder: async () => {
      const processed = new Set(
        customEntries(context, "harness:controller-command-processed").map(
          (entry) =>
            (entry.data as { commandKey?: string } | undefined)?.commandKey,
        ),
      );
      return customEntries(context, "harness:controller-command")
        .map(
          (entry) =>
            (entry.data as { idempotencyKey?: string } | undefined)
              ?.idempotencyKey,
        )
        .filter(
          (key): key is string => key !== undefined && !processed.has(key),
        );
    },
  });
  return new HarnessController(queue);
}

class ProjectCommandBackend implements HarnessCommandBackend {
  private active: ProductionRunSystem | undefined;

  public constructor(
    private readonly cwd: string,
    private readonly controller: HarnessController,
    private readonly pi: ExtensionAPI,
    private readonly context: ExtensionContext,
    private readonly configuration?: LoadedProjectConfiguration,
    private readonly configurationError?: string,
  ) {}

  public async snapshot() {
    if (this.active !== undefined) return this.active.readState();
    return {
      project: this.cwd,
      ready: this.configuration !== undefined,
      workflowRevision: this.configuration?.workflow.revision,
      configurationError: this.configurationError,
    };
  }

  public async graph() {
    if (this.active !== undefined) return this.active.graph().graph;
    return {
      workflow: this.configuration?.workflow.stages.map((stage) => ({
        id: stage.id,
        needs: stage.needs ?? [],
      })) ?? [],
    };
  }

  public async logs(target?: string) {
    if (this.active !== undefined) {
      const state = await this.active.readState();
      return [JSON.stringify(target === undefined ? state : state.jobs[target] ?? null, null, 2)];
    }
    return [`No resident logs recorded${target ? ` for ${target}` : ""}`];
  }

  public async doctor() {
    return this.configuration === undefined
      ? {
          ready: false,
          summary: this.configurationError ?? "Harness is not initialized",
        }
      : {
          ready: true,
          summary: `Configuration valid and production runtime available (${this.configuration.workflow.revision})`,
        };
  }

  public async previewRun(_target?: string) {
    if (this.configuration === undefined) {
      throw new Error(this.configurationError ?? "Harness is not initialized");
    }
    const stages = this.configuration.workflow.stages;
    const workers = new Set<string>();
    const profiles = new Set<string>();
    for (const stage of stages) {
      if (typeof stage.runner === "object") {
        stage.runner.prefer.forEach((item) => workers.add(item));
      }
      if (stage.model_profile) profiles.add(stage.model_profile);
    }
    return {
      workflowHash: this.configuration.workflow.revision,
      commands: this.configuration.commands,
      workers: [...workers],
      credentialProfiles: [...profiles],
      permissions: this.configuration.permissions,
      branches: ["harness/run-<run-id>", "harness/<run-id>-<task-id>"],
      effects: previewEffectKinds(stages),
    };
  }

  public async enqueue(command: ControllerCommand): Promise<void> {
    if (
      command.source === "operator" &&
      command.kind === "operator_intent" &&
      typeof command.payload === "object" &&
      command.payload !== null &&
      !Array.isArray(command.payload) &&
      command.payload.operation === "run"
    ) {
      if (this.configuration === undefined) {
        throw new Error(this.configurationError ?? "Harness is not initialized");
      }
      if (this.active !== undefined) throw new Error("a harness run is already active");
      const payload = command.payload as Record<string, unknown>;
      const preview = await this.previewRun(
        typeof payload.target === "string" ? payload.target : undefined,
      );
      const approved = payload.approvedPreviewHash;
      const expected = sha256(canonicalJson(preview));
      if (approved !== expected) {
        throw new Error("run approval does not match the current frozen preview");
      }
      const repository = await GitRepository.open(this.cwd);
      const inspection = await repository.inspect();
      if (inspection.branch === null) throw new Error("production run requires a branch checkout");
      const requested = typeof payload.target === "string" ? payload.target : "";
      const runId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested)
        ? requested
        : `F${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
      const initialized = await initializeProductionRun({
        root: inspection.root,
        runId,
        workflowRevision: this.configuration.workflow.revision,
        approvedPreviewHash: expected,
        artifactPaths: artifactPaths(this.configuration.workflow),
        remote: "origin",
        baseBranch: inspection.branch,
      });
      this.active = await composeProductionRun({
        initialized,
        workflow: this.configuration.workflow,
        artifactPaths: artifactPaths(this.configuration.workflow),
        commands: this.configuration.commands,
        pi: this.pi,
        context: this.context,
      });
      await this.active.controller.enqueue(command);
      return;
    }
    await (this.active?.controller ?? this.controller).enqueue(command);
  }

  public async runtime(command: ControllerCommand): Promise<unknown> {
    return (this.active?.controller ?? this.controller).enqueue(command);
  }

  public async dispose(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    await active?.dispose();
  }
}

export function createPiExtensionDependencies(
  pi: ExtensionAPI,
): LazyExtensionDependencies {
  return createLazyExtensionDependencies({
    async create(context) {
      let configuration: LoadedProjectConfiguration | undefined;
      let configurationError: string | undefined;
      try {
        configuration = await loadProjectConfiguration(context.cwd);
      } catch (error) {
        configurationError =
          error instanceof Error ? error.message : String(error);
      }
      const controller = sessionController(pi, context);
      await controller.recoverPending();
      const backend = new ProjectCommandBackend(
        context.cwd,
        controller,
        pi,
        context,
        configuration,
        configurationError,
      );
      const sessionFile = context.sessionManager.getSessionFile();
      return {
        cwd: context.cwd,
        ...(sessionFile === undefined ? {} : { sessionFile }),
        commands: new HarnessCommandService(backend),
        events: new ControllerEventRouter({ enqueue: (command) => backend.runtime(command) }),
        async dispose() {
          await backend.dispose();
          await controller.drain();
        },
      };
    },
  });
}

export function createLazyExtensionDependencies(
  factory: HarnessSessionDependencyFactory = defaultFactory,
): LazyExtensionDependencies {
  let active: HarnessSessionDependencies | undefined;
  let starting: Promise<HarnessSessionDependencies> | undefined;
  return {
    async start(context) {
      if (active !== undefined) return active;
      if (starting !== undefined) return starting;
      starting = factory.create(context).then((created) => {
        active = created;
        return created;
      });
      try {
        return await starting;
      } finally {
        starting = undefined;
      }
    },
    current() {
      return active;
    },
    async dispose() {
      const dependency =
        active ?? (starting === undefined ? undefined : await starting);
      active = undefined;
      starting = undefined;
      await dependency?.dispose();
    },
  };
}
