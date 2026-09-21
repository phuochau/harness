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
  public constructor(
    private readonly cwd: string,
    private readonly controller: HarnessController,
    private readonly configuration?: LoadedProjectConfiguration,
    private readonly configurationError?: string,
  ) {}

  public async snapshot() {
    return {
      project: this.cwd,
      ready: this.configuration !== undefined,
      workflowRevision: this.configuration?.workflow.revision,
      configurationError: this.configurationError,
    };
  }

  public async graph() {
    return {
      workflow: this.configuration?.workflow.stages.map((stage) => ({
        id: stage.id,
        needs: stage.needs ?? [],
      })) ?? [],
    };
  }

  public async logs(target?: string) {
    return [`No resident logs recorded${target ? ` for ${target}` : ""}`];
  }

  public async doctor() {
    return this.configuration === undefined
      ? {
          ready: false,
          summary: this.configurationError ?? "Harness is not initialized",
        }
      : {
          ready: false,
          summary:
            `Configuration valid (${this.configuration.workflow.revision}), ` +
            "but resident production action adapters are not connected in this build",
        };
  }

  public async previewRun() {
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
      throw new Error(
        "resident production action adapters are not connected; run was not accepted",
      );
    }
    await this.controller.enqueue(command);
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
        configuration,
        configurationError,
      );
      const sessionFile = context.sessionManager.getSessionFile();
      return {
        cwd: context.cwd,
        ...(sessionFile === undefined ? {} : { sessionFile }),
        commands: new HarnessCommandService(backend),
        events: new ControllerEventRouter(controller),
        async dispose() {
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
