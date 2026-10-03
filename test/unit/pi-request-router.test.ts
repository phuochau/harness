import { expect, it } from "vitest";
import { parseRequestDecision, routeHarnessRequest } from "../../src/pi/request-router.js";

it("accepts only closed, confident request decisions", () => {
  expect(parseRequestDecision('{"route":"run","kind":"bugfix","reason":"Existing behavior fails"}')).toEqual({
    route: "run", kind: "bugfix", reason: "Existing behavior fails",
  });
  expect(parseRequestDecision('{"route":"run","kind":"unknown","reason":"x"}')).toBeUndefined();
  expect(parseRequestDecision('{"route":"run","kind":"bugfix","reason":"x","command":"cancel"}')).toBeUndefined();
  expect(parseRequestDecision('{"route":"command","command":"cancel","target":"T001","reason":"Stop the task"}')).toEqual({
    route: "command", command: "cancel", target: "T001", reason: "Stop the task",
  });
  expect(parseRequestDecision('{"route":"command","command":"push","reason":"x"}')).toBeUndefined();
  expect(parseRequestDecision("not JSON")).toBeUndefined();
});

function fixture(answer: string | undefined) {
  const called: string[] = [];
  return {
    called,
    ports: {
      classify: async () => answer,
      discuss: (description: string) => { called.push(`discuss:${description}`); },
      execute: async (command: string, args: string) => { called.push(`${command}:${args}`); },
      notify: (message: string) => { called.push(`notify:${message}`); },
      confirm: async () => { called.push("confirm"); return true; },
    },
  };
}

it("sends an uncertain or unavailable classification to ordinary conversation", async () => {
  const run = fixture(undefined);
  await routeHarnessRequest("Could we improve the project page?", run.ports);
  expect(run.called).toEqual(["discuss:Could we improve the project page?"]);
});

it("proposes a run with the literal description as the brief", async () => {
  const run = fixture('{"route":"run","kind":"bugfix","reason":"A concrete existing behavior"}');
  await routeHarnessRequest("Fix Shift-click -- do not lose edits", run.ports);
  expect(run.called).toContain("harness:run:--kind bugfix -- Fix Shift-click -- do not lose edits");
  expect(run.called).not.toContain("confirm");
});

it("routes read-only requests and confirms mutating operations", async () => {
  const status = fixture('{"route":"command","command":"status","reason":"Show run state"}');
  await routeHarnessRequest("Show status", status.ports);
  expect(status.called).toContain("harness:status:");
  expect(status.called).not.toContain("confirm");

  const cancel = fixture('{"route":"command","command":"cancel","target":"T001","reason":"Stop task"}');
  await routeHarnessRequest("Cancel T001", cancel.ports);
  expect(cancel.called).toEqual(expect.arrayContaining(["confirm", "harness:cancel:T001"]));
});

it("does not execute an operation without a required target", async () => {
  const run = fixture('{"route":"command","command":"cancel","reason":"Stop a task"}');
  await routeHarnessRequest("Cancel it", run.ports);
  expect(run.called).toEqual(["discuss:Cancel it"]);
});
