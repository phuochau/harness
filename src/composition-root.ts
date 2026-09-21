import type { CompiledWorkflow } from "./config/compile.js";
import {
  WorkflowScheduler,
  type SchedulerActionDispatcher,
  type SchedulerState,
} from "./core/scheduler.js";
import type { ValidatedTaskGraph } from "./core/task-graph.js";

export interface HarnessPorts {
  readonly workflow: CompiledWorkflow;
  readonly taskGraph: ValidatedTaskGraph;
  readonly actions: SchedulerActionDispatcher;
}

export interface HarnessSystem {
  readonly workflowRevision: string;
  readonly state: SchedulerState;
  readonly actions: SchedulerActionDispatcher;
  runToQuiescence(): Promise<void>;
}

/**
 * Deterministic in-memory runner for simulation and black-box tests.
 * Production callers must use the durable composition root exported as
 * `createHarnessSystem` from the package entrypoint.
 */
export function createInMemoryHarnessSystem(ports: HarnessPorts): HarnessSystem {
  const scheduler = new WorkflowScheduler(ports.workflow, ports.taskGraph);
  return Object.freeze({
    workflowRevision: ports.workflow.revision,
    state: scheduler.state,
    actions: ports.actions,
    runToQuiescence: () => scheduler.runToQuiescence(ports.actions),
  });
}
