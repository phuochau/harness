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

export interface CompileInput {
  readonly workflow: WorkflowDocument;
  readonly environment: EnvironmentDocument;
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
  readonly revision: `sha256:${string}`;
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
  const schemas = {
    ...BuiltInActionInputSchemas,
    ...(input.actionSchemas ?? {}),
  };
  const ordered = topologicalStages(document.stages);
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
  };
  return deepFreeze({ ...normalized, revision: contentRevision(normalized) });
}
