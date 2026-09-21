import type {
  TaskGraphDocument,
  TaskNode,
} from "../contracts/task-graph.js";
import { validateTaskGraph } from "../contracts/task-graph.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { normalizeOwnedPath, pathsOverlap } from "./path-conflicts.js";

export interface GraphContext {
  readonly tasksSemanticHash: string;
  readonly taskRecords: ReadonlyMap<string, TaskNode>;
  readonly acceptanceRefs: ReadonlySet<string>;
}

export interface ValidatedTaskGraph {
  readonly graph: TaskGraphDocument;
  readonly byId: ReadonlyMap<string, TaskNode>;
  readonly order: readonly string[];
  readonly reachability: ReadonlyMap<string, ReadonlySet<string>>;
}

export class GraphError extends Error {}

function normalizedTask(task: TaskNode): TaskNode {
  return {
    ...task,
    labels: [...task.labels].sort(),
    dependsOn: [...task.dependsOn].sort(),
    acceptanceRefs: [...task.acceptanceRefs].sort(),
    ownedPaths: task.ownedPaths.map(normalizeOwnedPath).sort(),
  };
}

function assertCanonicalProjection(actual: TaskNode, expected?: TaskNode): void {
  if (!expected) throw new GraphError(`task ${actual.id} does not match tasks.md`);
  if (JSON.stringify(normalizedTask(actual)) !== JSON.stringify(normalizedTask(expected))) {
    throw new GraphError(`task ${actual.id} does not match tasks.md`);
  }
}

function topologicalOrder(byId: ReadonlyMap<string, TaskNode>): string[] {
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (permanent.has(id)) return;
    if (temporary.has(id)) throw new GraphError(`task dependency cycle includes ${id}`);
    temporary.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    order.push(id);
  };
  for (const id of byId.keys()) visit(id);
  return order;
}

function computeReachability(
  byId: ReadonlyMap<string, TaskNode>,
): Map<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  const descendants = (source: string): Set<string> => {
    const reachable = new Set<string>();
    const walk = (current: string): void => {
      for (const [candidate, task] of byId) {
        if (!task.dependsOn.includes(current) || reachable.has(candidate)) continue;
        reachable.add(candidate);
        walk(candidate);
      }
    };
    walk(source);
    return reachable;
  };
  for (const id of byId.keys()) result.set(id, descendants(id));
  return result;
}

function rejectUnorderedPathOverlap(
  tasks: readonly TaskNode[],
  reachability: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const left = tasks[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const right = tasks[rightIndex]!;
      if (!left.parallelEligible || !right.parallelEligible) continue;
      const ordered =
        reachability.get(left.id)?.has(right.id) === true ||
        reachability.get(right.id)?.has(left.id) === true;
      if (ordered) continue;
      for (const leftPath of left.ownedPaths) {
        for (const rightPath of right.ownedPaths) {
          if (
            pathsOverlap(
              normalizeOwnedPath(leftPath),
              normalizeOwnedPath(rightPath),
            )
          ) {
            throw new GraphError(
              `owned path conflict between ${left.id} and ${right.id}: ${leftPath}`,
            );
          }
        }
      }
    }
  }
}

export function validateGraph(
  graphValue: TaskGraphDocument,
  context: GraphContext,
): ValidatedTaskGraph {
  const graph = structuredClone(validateTaskGraph(graphValue));
  if (graph.tasksSemanticHash !== context.tasksSemanticHash) {
    throw new GraphError("stale semantic hash");
  }
  const byId = new Map<string, TaskNode>();
  for (const task of graph.tasks) {
    if (byId.has(task.id)) throw new GraphError(`duplicate task ${task.id}`);
    byId.set(task.id, task);
  }
  if (
    byId.size !== context.taskRecords.size ||
    [...context.taskRecords.keys()].some((id) => !byId.has(id))
  ) {
    throw new GraphError("task set does not match tasks.md");
  }
  for (const task of graph.tasks) {
    assertCanonicalProjection(task, context.taskRecords.get(task.id));
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new GraphError(`unknown dependency ${dependency}`);
      }
    }
    for (const reference of task.acceptanceRefs) {
      if (!context.acceptanceRefs.has(reference)) {
        throw new GraphError(`unknown acceptance reference ${reference}`);
      }
    }
    task.ownedPaths.forEach(normalizeOwnedPath);
  }
  const order = topologicalOrder(byId);
  const reachability = computeReachability(byId);
  rejectUnorderedPathOverlap(graph.tasks, reachability);
  return deepFreeze({ graph, byId, order, reachability });
}
