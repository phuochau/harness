import { expect, it } from "vitest";
import {
  parseRunRequest,
  RUN_BRIEF_MAX_BYTES,
  runRequestFromPayload,
  taskKinds,
} from "../../src/pi/run-request.js";

it("parses a legacy bare run target without flags", () => {
  expect(parseRunRequest("F023")).toEqual({
    runId: "F023",
    kind: "large-feature",
  });
  expect(parseRunRequest("   ")).toEqual({ kind: "large-feature" });
  expect(parseRunRequest("")).toEqual({ kind: "large-feature" });
});

it("preserves the legacy free-form target verbatim", () => {
  expect(parseRunRequest("  add the login feature  ")).toEqual({
    runId: "add the login feature",
    kind: "large-feature",
  });
});

it.each(["bugfix", "small-feature", "large-feature"] as const)(
  "parses --kind %s with a literal brief",
  (kind) => {
    expect(parseRunRequest(`F100 --kind ${kind} -- tighten the parser`)).toEqual({
      runId: "F100",
      kind,
      brief: "tighten the parser",
    });
  },
);

it("exposes exactly the three supported task kinds", () => {
  expect(taskKinds).toEqual(["bugfix", "small-feature", "large-feature"]);
});

it("allows a generated run id when flags are present without a target", () => {
  expect(parseRunRequest("--kind bugfix -- fix the crash")).toEqual({
    kind: "bugfix",
    brief: "fix the crash",
  });
});

it("defaults the kind to large-feature when only a brief separator is given", () => {
  expect(parseRunRequest("F100 -- extend the parser")).toEqual({
    runId: "F100",
    kind: "large-feature",
    brief: "extend the parser",
  });
});

it("rejects a missing or unknown kind", () => {
  expect(() => parseRunRequest("F100 --kind -- brief")).toThrow(/kind/);
  expect(() => parseRunRequest("F100 --kind")).toThrow(/kind/);
  expect(() => parseRunRequest("F100 --kind hotfix -- brief")).toThrow(/hotfix/);
  expect(() => parseRunRequest("F100 --kind ../escape -- brief")).toThrow(/kind/);
  expect(() => parseRunRequest("F100 --kind ./workflow.yaml -- brief")).toThrow(
    /kind/,
  );
});

it("rejects a quick kind without a brief separator", () => {
  expect(() => parseRunRequest("F100 --kind bugfix")).toThrow(/brief/);
  expect(() => parseRunRequest("F100 --kind small-feature")).toThrow(/brief/);
});

it("rejects an empty or over-sized brief", () => {
  expect(() => parseRunRequest("F100 --kind bugfix --")).toThrow(/brief/);
  expect(() => parseRunRequest("F100 --kind bugfix --    ")).toThrow(/brief/);
  const oversized = "x".repeat(RUN_BRIEF_MAX_BYTES + 1);
  expect(() => parseRunRequest(`F100 --kind bugfix -- ${oversized}`)).toThrow(
    /4096|byte|brief/i,
  );
  const maximal = "x".repeat(RUN_BRIEF_MAX_BYTES);
  expect(parseRunRequest(`F100 --kind bugfix -- ${maximal}`).brief).toBe(maximal);
});

it("rejects a malformed run id in the flagged syntax", () => {
  expect(() => parseRunRequest("bad$id --kind bugfix -- fix it")).toThrow(
    /run id/i,
  );
  expect(() =>
    parseRunRequest("F100 extra-token --kind bugfix -- fix it"),
  ).toThrow();
});

it("rejects unknown flags", () => {
  expect(() => parseRunRequest("F100 --kind bugfix --fast -- fix it")).toThrow(
    /--fast|unknown/i,
  );
  expect(() =>
    parseRunRequest("F100 --workflow evil.yaml --kind bugfix -- fix it"),
  ).toThrow(/--workflow|unknown/i);
  expect(() =>
    parseRunRequest("F100 --kind bugfix --kind small-feature -- fix it"),
  ).toThrow(/kind|duplicate/i);
});

it("keeps quoted-looking and shell-looking brief text literal", () => {
  const brief = `fix "quoted" $(rm -rf /) ; \`ticks\` and $HOME`;
  expect(parseRunRequest(`F100 --kind bugfix -- ${brief}`)).toEqual({
    runId: "F100",
    kind: "bugfix",
    brief,
  });
});

it("keeps later separators inside the brief literal", () => {
  expect(
    parseRunRequest("F100 --kind bugfix -- fix -- the -- dashes"),
  ).toEqual({
    runId: "F100",
    kind: "bugfix",
    brief: "fix -- the -- dashes",
  });
});

it("rebuilds an equivalent request from an approved intent payload", () => {
  expect(runRequestFromPayload({ target: "F100" })).toEqual({
    runId: "F100",
    kind: "large-feature",
  });
  expect(
    runRequestFromPayload({
      target: "F100",
      kind: "bugfix",
      brief: "fix the crash",
    }),
  ).toEqual({ runId: "F100", kind: "bugfix", brief: "fix the crash" });
  expect(runRequestFromPayload({})).toEqual({ kind: "large-feature" });
});

it("rejects malformed intent payload fields", () => {
  expect(() => runRequestFromPayload({ kind: "hotfix" })).toThrow(/kind/);
  expect(() => runRequestFromPayload({ brief: 42 })).toThrow(/brief/);
  expect(() => runRequestFromPayload({ brief: "" })).toThrow(/brief/);
  expect(() => runRequestFromPayload({ kind: "bugfix" })).toThrow(/brief/);
  expect(() => runRequestFromPayload({ target: 7 })).toThrow(/target/);
});
