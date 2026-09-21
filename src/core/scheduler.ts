import type { CompiledWorkflow } from "../config/compile.js";
import { materializeJobs, type MaterializedJob } from "./materialize.js";
import type { ValidatedTaskGraph } from "./task-graph.js";

export type SchedulerJobStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

export interface SchedulerAction {
  readonly kind: string;
  readonly jobId: string;
  readonly stageId: string;
  readonly taskId?: string;
  readonly attempt: number;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface SchedulerActionDispatcher {
  execute(action: SchedulerAction): Promise<unknown>;
}

export interface SchedulerState {
  readonly jobs: Record<string, { state: SchedulerJobStatus }>;
  readonly tasks: Record<string, { state: "PENDING" | "RUNNING" | "VERIFYING" | "DONE" }>;
}

export class WorkflowScheduler {
  public readonly state: SchedulerState;
  private readonly materialized;
  private readonly stageById;
  private readonly taskById;

  public constructor(
    private readonly workflow: CompiledWorkflow,
    private readonly graph: ValidatedTaskGraph,
  ) {
    this.materialized = materializeJobs(workflow, graph);
    this.stageById = new Map(workflow.stages.map((stage) => [stage.id, stage]));
    this.taskById = graph.byId;
    this.state = {
      jobs: Object.fromEntries(
        Object.keys(this.materialized.jobs).map((id) => [id, { state: "PENDING" }]),
      ),
      tasks: Object.fromEntries(
        graph.order.map((id) => [id, { state: "PENDING" }]),
      ),
    };
  }

  private isReady(job: MaterializedJob): boolean {
    if (this.state.jobs[job.id]?.state !== "PENDING") return false;
    if (
      job.dependsOn.some(
        (dependency) => this.state.jobs[dependency]?.state !== "DONE",
      )
    ) {
      return false;
    }
    const stage = this.stageById.get(job.stageId)!;
    if (stage.gate === "task.dependencies_done" && job.taskId) {
      const task = this.taskById.get(job.taskId)!;
      return task.dependsOn.every(
        (dependency) => this.state.tasks[dependency]?.state === "DONE",
      );
    }
    return true;
  }

  private selectBatch(ready: readonly MaterializedJob[]): MaterializedJob[] {
    const implementations = ready.filter(
      (job) => this.stageById.get(job.stageId)?.uses === "worker.execute",
    );
    if (implementations.length === 0) return [...ready];
    const nonParallel = implementations.find(
      (job) => job.taskId && !this.taskById.get(job.taskId)?.parallelEligible,
    );
    if (nonParallel) return [nonParallel];
    return implementations;
  }

  private async runJob(
    job: MaterializedJob,
    dispatcher: SchedulerActionDispatcher,
  ): Promise<void> {
    const stage = this.stageById.get(job.stageId)!;
    this.state.jobs[job.id]!.state = "RUNNING";
    if (job.taskId && stage.uses === "worker.execute") {
      this.state.tasks[job.taskId]!.state = "RUNNING";
    }
    await dispatcher.execute({
      kind: stage.action.kind,
      jobId: job.id,
      stageId: job.stageId,
      ...(job.taskId === undefined ? {} : { taskId: job.taskId }),
      attempt: 1,
      input: stage.action.input,
    });
    this.state.jobs[job.id]!.state = "DONE";
    if (job.taskId && stage.uses === "worker.execute") {
      this.state.tasks[job.taskId]!.state = "VERIFYING";
    }
    if (
      job.taskId &&
      this.workflow.taskModel?.complete_when.stage === stage.id
    ) {
      this.state.tasks[job.taskId]!.state = "DONE";
    }
  }

  public async runToQuiescence(
    dispatcher: SchedulerActionDispatcher,
  ): Promise<void> {
    while (true) {
      const pending = Object.values(this.state.jobs).some(
        (job) => job.state === "PENDING",
      );
      if (!pending) return;
      const ready = Object.values(this.materialized.jobs).filter((job) =>
        this.isReady(job),
      );
      if (ready.length === 0) throw new Error("scheduler stalled with pending jobs");
      const batch = this.selectBatch(ready);
      await Promise.all(batch.map((job) => this.runJob(job, dispatcher)));
    }
  }
}
