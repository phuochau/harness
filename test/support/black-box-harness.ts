import { createInMemoryHarnessSystem } from "../../src/composition-root.js";
import { compileWorkflow } from "../../src/config/compile.js";
import type { TaskGraphDocument } from "../../src/contracts/task-graph.js";
import type { SchedulerAction, SchedulerActionDispatcher } from "../../src/core/scheduler.js";
import { validateGraph } from "../../src/core/task-graph.js";
import type { WorkerKind } from "../../src/core/routing.js";
import {
  fixtureCompileInput,
  fixtureGraphContextFor,
} from "./factories.js";

interface ReviewRecord {
  readonly taskId?: string;
  readonly worker: WorkerKind;
  readonly implementationWorker?: WorkerKind;
  readonly reviewedCommit: string;
  readonly outcome: "approved";
}

interface PullRequestRecord {
  readonly url: string;
  readonly headCommit: string;
}

class BlackBoxActions implements SchedulerActionDispatcher {
  private activeImplementations = 0;
  public maxConcurrentImplementation = 0;
  public readonly implementations = new Map<string, WorkerKind>();
  public readonly taskReviews: ReviewRecord[] = [];
  public readonly finalReviews: ReviewRecord[] = [];
  public readonly pullRequests: PullRequestRecord[] = [];
  public runHead = "base";
  public pushedCommit = "";
  public runBranchWasUnchangedDuringCandidateVerification = true;
  private readonly candidates = new Map<string, string>();

  public constructor(
    private readonly unavailable: ReadonlySet<WorkerKind>,
  ) {}

  private select(preference: readonly WorkerKind[], excluded?: WorkerKind): WorkerKind {
    const selected = preference.find(
      (worker) => worker !== excluded && !this.unavailable.has(worker),
    );
    if (selected === undefined) throw new Error("no eligible worker");
    return selected;
  }

  public async execute(action: SchedulerAction): Promise<unknown> {
    if (action.kind === "worker.execute") {
      const taskId = action.taskId!;
      const worker = this.select(["devin", "codex", "claude"]);
      this.implementations.set(taskId, worker);
      this.activeImplementations += 1;
      this.maxConcurrentImplementation = Math.max(
        this.maxConcurrentImplementation,
        this.activeImplementations,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.activeImplementations -= 1;
      return { outcome: "completed", worker, commits: [`worker:${taskId}:1`, `worker:${taskId}:2`] };
    }
    if (action.kind === "worker.review") {
      if (action.taskId !== undefined) {
        const implementationWorker = this.implementations.get(action.taskId)!;
        const worker = this.select(["codex", "claude", "devin"], implementationWorker);
        const review: ReviewRecord = {
          taskId: action.taskId,
          worker,
          implementationWorker,
          reviewedCommit: `worker:${action.taskId}:2`,
          outcome: "approved",
        };
        this.taskReviews.push(review);
        return review;
      }
      const review: ReviewRecord = {
        worker: this.select(["codex", "claude", "devin"]),
        reviewedCommit: this.runHead,
        outcome: "approved",
      };
      this.finalReviews.push(review);
      return review;
    }
    if (action.kind === "git.integrate") {
      const candidate = `candidate:${action.taskId}`;
      this.candidates.set(action.taskId!, candidate);
      const beforeVerification = this.runHead;
      await Promise.resolve();
      this.runBranchWasUnchangedDuringCandidateVerification &&=
        this.runHead === beforeVerification;
      return { candidateCommit: candidate, expectedRunHead: beforeVerification };
    }
    if (action.kind === "git.project-task-status") {
      this.runHead = `run:${action.taskId}:${this.candidates.get(action.taskId!)}`;
      return { targetCommit: this.runHead };
    }
    if (action.kind === "git.push") {
      this.pushedCommit = this.runHead;
      return { pushedCommit: this.pushedCommit };
    }
    if (action.kind === "github.pull-request") {
      const pullRequest = {
        url: "https://example.invalid/pr/1",
        headCommit: this.pushedCommit,
      };
      this.pullRequests.push(pullRequest);
      return pullRequest;
    }
    return { ok: true };
  }
}

export async function createBlackBoxHarness(input: {
  readonly graph: TaskGraphDocument;
  readonly unavailable?: readonly WorkerKind[];
}) {
  const workflow = compileWorkflow(fixtureCompileInput());
  const validated = validateGraph(input.graph, fixtureGraphContextFor(input.graph));
  const actions = new BlackBoxActions(new Set(input.unavailable ?? []));
  const system = createInMemoryHarnessSystem({ workflow, taskGraph: validated, actions });
  return {
    async runToQuiescence() {
      await system.runToQuiescence();
      return {
        taskStates: Object.fromEntries(
          Object.entries(system.state.tasks).map(([id, task]) => [id, task.state]),
        ),
        maxConcurrentImplementation: actions.maxConcurrentImplementation,
        taskReviews: actions.taskReviews,
        finalReviews: actions.finalReviews,
        runBranchWasUnchangedDuringCandidateVerification:
          actions.runBranchWasUnchangedDuringCandidateVerification,
        pushedCommit: actions.pushedCommit,
        pullRequests: actions.pullRequests,
        implementations: Object.fromEntries(actions.implementations),
      };
    },
  };
}
