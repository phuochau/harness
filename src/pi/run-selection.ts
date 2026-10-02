import {
  stageProfileIds,
  type EnvironmentDocument,
  type WorkflowDocument,
} from "../contracts/index.js";
import {
  compileWorkflow,
  injectCompiledActionInput,
  type CompiledWorkflow,
} from "../config/compile.js";
import type { ResolvedProfiles } from "../config/profiles.js";
import { readQuickWorkflowPreset } from "../cli/trusted-project-reader.js";
import type { RunPreview } from "./commands.js";
import type { RunRequest } from "./run-request.js";

export interface RunSelectionContext {
  readonly root: string;
  readonly workflowDocument: WorkflowDocument;
  readonly defaultWorkflow: CompiledWorkflow;
  readonly environment: EnvironmentDocument;
  readonly profiles: ResolvedProfiles;
}

export function previewEffectKinds(
  stages: readonly { readonly uses: string }[],
): readonly string[] {
  return [...new Set(stages.map((stage) => stage.uses))];
}

export async function compileRunSelection(
  context: RunSelectionContext,
  request: RunRequest,
): Promise<CompiledWorkflow> {
  if (request.kind === "large-feature") {
    if (request.brief === undefined) return context.defaultWorkflow;
    const compiled = compileWorkflow({
      workflow: context.workflowDocument,
      environment: context.environment,
      profiles: context.profiles,
    });
    return injectCompiledActionInput(compiled, "spec-kit.specify", {
      brief: request.brief,
    });
  }
  if (request.brief === undefined) {
    throw new Error(`task kind ${request.kind} requires a brief`);
  }
  const preset = await readQuickWorkflowPreset(context.root, request.kind);
  const compiled = compileWorkflow({
    workflow: preset,
    environment: context.environment,
    profiles: context.profiles,
  });
  if (compiled.stages.some((stage) =>
    stage.uses === "worker.execute" &&
    typeof stage.runner === "object" &&
    "by_complexity" in stage.runner
  )) {
    throw new Error(
      "by_complexity is unavailable for quick workflows until quick planning emits v2 task metadata",
    );
  }
  const planners = compiled.stages.filter(
    (stage) => stage.uses === "harness.quick-plan",
  );
  if (planners.length !== 1) {
    throw new Error("quick workflow must declare exactly one harness.quick-plan stage");
  }
  if (planners[0]?.action.input["kind"] !== request.kind) {
    throw new Error(
      `workflow preset .harness/workflows/${request.kind}.yaml must declare "kind: ${request.kind}" on its quick planning stage`,
    );
  }
  return injectCompiledActionInput(compiled, "harness.quick-plan", {
    brief: request.brief,
  });
}

export function buildRunPreview(
  request: RunRequest,
  workflow: CompiledWorkflow,
  commands: Readonly<Record<string, readonly string[]>>,
  permissions: readonly string[],
): RunPreview {
  const workers = new Set<string>();
  const profiles = new Set<string>();
  for (const stage of workflow.stages) {
    if (typeof stage.runner === "object") {
      stageProfileIds(stage).forEach((item) => workers.add(item));
    }
    if (stage.model_profile) profiles.add(stage.model_profile);
  }
  return {
    workflowHash: workflow.revision,
    kind: request.kind,
    ...(request.brief === undefined ? {} : { brief: request.brief }),
    commands,
    workers: [...workers],
    credentialProfiles: [...profiles],
    permissions,
    branches: ["harness/run-<run-id>", "harness/<run-id>-<task-id>"],
    effects: previewEffectKinds(workflow.stages),
  };
}
