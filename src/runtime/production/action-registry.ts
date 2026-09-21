import { CommandAction } from "../../actions/command.js";
import { GitIntegrateAction } from "../../actions/git-integrate.js";
import { GitProjectTaskStatusAction } from "../../actions/git-project-task-status.js";
import { GitPushAction } from "../../actions/git-push.js";
import { GitHubPullRequestAction } from "../../actions/github-pr.js";
import { ActionRegistry } from "../../actions/registry.js";
import type { PlanningAgent } from "../../ports/planning.js";
import type { RunManifest } from "../../state/run-manifest.js";
import type { DurableRecordStore } from "./records.js";
import type { ProductionWorkerRuntime } from "./worker-action.js";
import { DurableWorkerAction } from "./worker-action.js";
import { DurableBoundAction } from "./bound-action.js";
import {
  ProductionActionBinders,
  validateBoundCommand,
  validateCommandOutput,
  validateFinalizationInput,
  validateFinalizationOutput,
  validateIntegrationInput,
  validateIntegrationOutput,
  validatePullRequestInput,
  validatePullRequestOutput,
  validatePushInput,
  validatePushOutput,
  type ProductionActionBinderOptions,
  type BoundCommandInput,
} from "./action-binders.js";
import { DurablePlanningAction } from "./planning-action.js";
import type { PlanningActionOutput } from "./planning-action.js";
import { RunApprovalAction } from "./run-approval.js";
import type { JournalVerificationObservations } from "./journal-observations.js";

export interface ProductionActionRegistryOptions extends ProductionActionBinderOptions {
  readonly manifest: RunManifest;
  readonly records: DurableRecordStore;
  readonly planningRoot: string;
  readonly planning: PlanningAgent;
  readonly workerRuntime: ProductionWorkerRuntime;
  readonly verificationObservations: JournalVerificationObservations;
  readonly afterPlanningCompleted?: (output: PlanningActionOutput) => Promise<void>;
}

export function createProductionActionRegistry(
  options: ProductionActionRegistryOptions,
): ActionRegistry {
  const registry = new ActionRegistry();
  const binders = new ProductionActionBinders(options);
  registry.register(new DurablePlanningAction("spec-kit.specify", {
    runId: options.manifest.runId,
    root: options.planningRoot,
    artifactPaths: options.manifest.artifactPaths,
    records: options.records,
    planning: options.planning,
    ...(options.afterPlanningCompleted === undefined ? {} : { afterCompleted: options.afterPlanningCompleted }),
  }));
  registry.register(new DurablePlanningAction("spec-kit.plan", {
    runId: options.manifest.runId,
    root: options.planningRoot,
    artifactPaths: options.manifest.artifactPaths,
    records: options.records,
    planning: options.planning,
    ...(options.afterPlanningCompleted === undefined ? {} : { afterCompleted: options.afterPlanningCompleted }),
  }));
  registry.register(new RunApprovalAction());
  registry.register(new DurablePlanningAction("spec-kit.tasks", {
    runId: options.manifest.runId,
    root: options.planningRoot,
    artifactPaths: options.manifest.artifactPaths,
    records: options.records,
    planning: options.planning,
    ...(options.afterPlanningCompleted === undefined ? {} : { afterCompleted: options.afterPlanningCompleted }),
  }));
  registry.register(new DurableWorkerAction("worker.execute", {
    records: options.records,
    runtime: options.workerRuntime,
  }));
  registry.register(new DurableWorkerAction("worker.review", {
    records: options.records,
    runtime: options.workerRuntime,
  }));
  registry.register(new DurableBoundAction({
    records: options.records,
    handler: new CommandAction(),
    binder: {
      bind: (intent) => binders.command(intent),
      afterCompleted: (input) => binders.afterCommand(input as BoundCommandInput),
    },
    recovery: "non_retryable",
    validateInput: validateBoundCommand,
    validateOutput: validateCommandOutput,
  }));
  registry.register(new DurableBoundAction({
    records: options.records,
    handler: new GitIntegrateAction(),
    binder: { bind: (intent) => binders.integrate(intent) },
    recovery: "reconcilable",
    validateInput: validateIntegrationInput,
    validateOutput: validateIntegrationOutput,
  }));
  registry.register(new DurableBoundAction({
    records: options.records,
    handler: new GitProjectTaskStatusAction(options.verificationObservations),
    binder: { bind: (intent) => binders.finalize(intent) },
    recovery: "reconcilable",
    validateInput: validateFinalizationInput,
    validateOutput: validateFinalizationOutput,
  }));
  registry.register(new DurableBoundAction({
    records: options.records,
    handler: new GitPushAction(),
    binder: { bind: (intent) => binders.push(intent) },
    recovery: "reconcilable",
    validateInput: validatePushInput,
    validateOutput: validatePushOutput,
  }));
  registry.register(new DurableBoundAction({
    records: options.records,
    handler: new GitHubPullRequestAction(),
    binder: { bind: (intent) => binders.pullRequest(intent) },
    recovery: "reconcilable",
    validateInput: validatePullRequestInput,
    validateOutput: validatePullRequestOutput,
  }));
  return registry;
}
