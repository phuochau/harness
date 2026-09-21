import { expect, it } from "vitest";
import { validateGraph } from "../../../src/core/task-graph.js";
import {
  diamondTaskGraph,
  fixtureGraphContext,
  fixtureGraphContextFor,
  fixtureTaskGraph,
  taskGraphCase,
} from "../../support/factories.js";

it.each([
  ["duplicate", taskGraphCase("duplicate"), fixtureGraphContext(), /duplicate task/],
  [
    "unknown dependency",
    taskGraphCase("unknown_dependency"),
    fixtureGraphContextFor(taskGraphCase("unknown_dependency")),
    /unknown dependency/,
  ],
  [
    "cycle",
    taskGraphCase("cycle"),
    fixtureGraphContextFor(taskGraphCase("cycle")),
    /cycle/,
  ],
  [
    "stale hash",
    fixtureTaskGraph(),
    fixtureGraphContext({ tasksSemanticHash: `sha256:${"b".repeat(64)}` }),
    /semantic hash/,
  ],
  [
    "projection mismatch",
    taskGraphCase("changed_owned_path"),
    fixtureGraphContext(),
    /does not match tasks.md/,
  ],
  [
    "parallel overlap",
    taskGraphCase("unordered_overlap"),
    fixtureGraphContextFor(taskGraphCase("unordered_overlap")),
    /owned path conflict/,
  ],
])("rejects %s", (_name, graph, context, error) => {
  expect(() => validateGraph(graph, context)).toThrow(error);
});

it("accepts a valid diamond and causally ordered path overlap", () => {
  const validated = validateGraph(diamondTaskGraph(), fixtureGraphContext());
  expect(validated.order.slice(0, 2).sort()).toEqual(["T001", "T002"]);
  expect(validated.order.at(-1)).toBe("T003");

  const orderedOverlap = taskGraphCase("ordered_overlap");
  expect(() =>
    validateGraph(orderedOverlap, fixtureGraphContextFor(orderedOverlap)),
  ).not.toThrow();
});

it("rejects unsafe and protected owned paths", () => {
  for (const path of ["../escape.ts", "/tmp/absolute", ".harness/policy.yaml"]) {
    const graph = structuredClone(diamondTaskGraph());
    graph.tasks[0]!.ownedPaths = [path];
    expect(() => validateGraph(graph, fixtureGraphContextFor(graph))).toThrow(
      /owned path/,
    );
  }
});
