import type { TSchema } from "typebox";
import {
  validateEnvironment,
  validateWorkflow,
  type EnvironmentDocument,
  type StageDocument,
  type WorkflowDocument,
} from "../contracts/index.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  BuiltInActionInputSchemas,
  validateActionInput,
} from "./action-inputs.js";
import { contentRevision } from "./hash.js";
import { resolveReferences } from "./interpolate.js";
import type { ResolvedProfiles } from "./profiles.js";

export interface CompileInput {
  readonly workflow: WorkflowDocument;
  readonly environment: EnvironmentDocument;
  readonly profiles?: ResolvedProfiles;
  readonly actionSchemas?: Readonly<Record<string, TSchema>>;
}

export interface CompiledAction {
  readonly kind: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface CompiledStage extends StageDocument {
  readonly action: CompiledAction;
}

export interface CompiledWorkflow {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly taskModel?: Exclude<WorkflowDocument["task_model"], undefined>;
  readonly stages: readonly CompiledStage[];
  readonly profiles: ResolvedProfiles;
  readonly resolvedProfilesHash: `sha256:${string}`;
  readonly revision: `sha256:${string}`;
}

function stageProfileIds(stage: StageDocument): readonly string[] {
  if (stage.runner === undefined) return [];
  return typeof stage.runner === "string" ? [stage.runner] : stage.runner.prefer;
}

function expectedRole(stage: StageDocument): "planning" | "implementation" | "review" | undefined {
  if (stage.uses.startsWith("spec-kit.")) return "planning";
  if (stage.uses === "worker.execute") return "implementation";
  if (stage.uses === "worker.review") return "review";
  return undefined;
}

function validateStageProfiles(
  stages: readonly StageDocument[],
  profiles: ResolvedProfiles,
): void {
  for (const stage of stages) {
    const role = expectedRole(stage);
    for (const profileId of stageProfileIds(stage)) {
      const profile = profiles.byId[profileId];
      if (profile === undefined) {
        throw new Error(`unknown profile ${profileId} referenced by ${stage.id}`);
      }
      if (role !== undefined && profile.role !== role) {
        throw new Error(
          `profile ${profileId} has role ${profile.role}, expected ${role} for ${stage.id}`,
        );
      }
    }
  }
}

function topologicalStages(stages: readonly StageDocument[]): StageDocument[] {
  const byId = new Map<string, StageDocument>();
  for (const stage of stages) {
    if (byId.has(stage.id)) throw new Error(`duplicate stage ID: ${stage.id}`);
    byId.set(stage.id, stage);
  }
  for (const stage of stages) {
    for (const need of stage.needs ?? []) {
      const dependency = byId.get(need.stage);
      if (!dependency) {
        throw new Error(
          `unknown dependency ${need.stage} referenced by ${stage.id}`,
        );
      }
      if (
        need.scope === "same-item" &&
        (!stage.foreach ||
          !dependency.foreach ||
          stage.foreach.source !== dependency.foreach.source ||
          stage.foreach.key !== dependency.foreach.key)
      ) {
        throw new Error(
          `same-item dependency ${dependency.id} -> ${stage.id} requires matching foreach definitions`,
        );
      }
    }
  }

  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const ordered: StageDocument[] = [];
  const visit = (stage: StageDocument): void => {
    if (permanent.has(stage.id)) return;
    if (temporary.has(stage.id)) {
      throw new Error(`stage dependency cycle includes ${stage.id}`);
    }
    temporary.add(stage.id);
    for (const need of stage.needs ?? []) visit(byId.get(need.stage)!);
    temporary.delete(stage.id);
    permanent.add(stage.id);
    ordered.push(stage);
  };
  for (const stage of stages) visit(stage);
  return ordered;
}

function validateRemediationTargets(stages: readonly StageDocument[]): void {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const ancestors = (stage: StageDocument): Set<string> => {
    const result = new Set<string>();
    const walk = (current: StageDocument): void => {
      for (const need of current.needs ?? []) {
        if (result.has(need.stage)) continue;
        result.add(need.stage);
        walk(byId.get(need.stage)!);
      }
    };
    walk(stage);
    return result;
  };
  for (const stage of stages) {
    const targets = [
      stage.on_failure?.changes_requested &&
      "retry_stage" in stage.on_failure.changes_requested
        ? stage.on_failure.changes_requested.retry_stage
        : undefined,
      stage.on_failure?.verification_failed?.retry_stage,
    ].filter((target): target is string => target !== undefined);
    for (const target of targets) {
      const targetStage = byId.get(target);
      if (!targetStage || !ancestors(stage).has(target)) {
        throw new Error(`retry_stage ${target} must be an ancestor of ${stage.id}`);
      }
      if (!stage.retry || !targetStage.retry) {
        throw new Error(`retry_stage ${target} requires finite retry budgets`);
      }
      if (
        !stage.foreach ||
        !targetStage.foreach ||
        stage.foreach.source !== targetStage.foreach.source ||
        stage.foreach.key !== targetStage.foreach.key
      ) {
        throw new Error(`retry_stage ${target} must use the same item key`);
      }
    }
  }
}

export function compileWorkflow(input: CompileInput): CompiledWorkflow {
  const document = validateWorkflow(structuredClone(input.workflow));
  const environment = validateEnvironment(structuredClone(input.environment));
  const profiles = structuredClone(
    input.profiles ?? {
      byId: {},
      hash: contentRevision({}),
    },
  );
  const schemas = {
    ...BuiltInActionInputSchemas,
    ...(input.actionSchemas ?? {}),
  };
  const ordered = topologicalStages(document.stages);
  if (input.profiles !== undefined) validateStageProfiles(ordered, profiles);
  validateRemediationTargets(ordered);
  const stages = ordered.map((stage) => ({
    ...stage,
    action: {
      kind: stage.uses,
      input: validateActionInput(
        stage.uses,
        resolveReferences(stage.with ?? {}, environment.commands),
        schemas,
      ),
    },
  }));
  const normalized = {
    schemaVersion: 1 as const,
    name: document.name,
    ...(document.task_model === undefined ? {} : { taskModel: document.task_model }),
    stages,
    profiles,
    resolvedProfilesHash: profiles.hash,
  };
  return deepFreeze({ ...normalized, revision: contentRevision(normalized) });
}
