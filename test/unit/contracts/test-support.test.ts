import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  validateEnvironmentAndLock,
  validateHarnessEvent,
  validateTaskGraph,
  validateWorkflow,
  validateWorkerResult,
} from "../../../src/contracts/index.js";
import { FakeClock } from "../../support/fake-clock.js";
import { FakeProcessRunner } from "../../support/fake-process.js";
import {
  completedResult,
  diamondTaskGraph,
  fixtureEnvironment,
  fixtureEvent,
  fixtureHarnessLock,
  fixtureState,
  fixtureTaskGraph,
  fixtureWorkflow,
} from "../../support/factories.js";
import { createTempRepo } from "../../support/temp-repo.js";

it("builds schema-valid independent fixtures", () => {
  expect(validateWorkflow(fixtureWorkflow()).schema).toBe("harness/v1");
  expect(
    validateEnvironmentAndLock(fixtureEnvironment(), fixtureHarnessLock()),
  ).toBeTruthy();
  expect(validateTaskGraph(fixtureTaskGraph())).toBeTruthy();
  expect(validateHarnessEvent(fixtureEvent()).eventHash).toMatch(
    /^sha256:[0-9a-f]{64}$/,
  );
  expect(validateWorkerResult(completedResult())).toBeTruthy();
  expect(fixtureState().runId).toBe("F023");
  expect(diamondTaskGraph().tasks.map((task) => task.id)).toEqual([
    "T001",
    "T002",
    "T003",
  ]);
});

it("deeply freezes fixture values and keeps overrides independent", () => {
  const first = fixtureWorkflow({ name: "first" });
  const second = fixtureWorkflow();
  expect(first.name).toBe("first");
  expect(second.name).not.toBe("first");
  expect(Object.isFrozen(first.stages)).toBe(true);
});

it("advances fake time and records byte-preserving process calls", async () => {
  const clock = new FakeClock("2026-09-20T00:00:00.000Z");
  let fired = false;
  clock.setTimeout(() => {
    fired = true;
  }, 10);
  clock.advanceBy(9);
  expect(fired).toBe(false);
  clock.advanceBy(1);
  expect(fired).toBe(true);

  const process = new FakeProcessRunner();
  process.queueBytes({
    exitCode: 0,
    stdout: new Uint8Array([0, 255]),
    stderr: "",
  });
  const result = await process.runBytes("git", ["show"], {
    stdin: new Uint8Array([1, 2]),
    shell: false,
  });
  expect([...result.stdout]).toEqual([0, 255]);
  expect(process.calls[0]).toMatchObject({ executable: "git", argv: ["show"] });
});

it("creates a Git repository with an initial commit", async () => {
  const repo = await createTempRepo();
  try {
    expect(await readFile(join(repo.path, "README.md"), "utf8")).toContain(
      "fixture",
    );
    const log = await repo.process.run("git", ["log", "-1", "--format=%s"], {
      cwd: repo.path,
      shell: false,
    });
    expect(log.stdout.trim()).toBe("initial fixture");
  } finally {
    await rm(repo.path, { recursive: true, force: true });
  }
});
