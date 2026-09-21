import { expect, it } from "vitest";
import { createAssignment } from "../../../src/core/assignment.js";
import { workerAdapters } from "../../../src/runtime/workers/index.js";
import { assignmentFixture } from "../../support/controller-fixtures.js";
import { FakeProcessRunner } from "../../support/fake-process.js";
import {
  contractAssignment,
  nativeSessionRef,
  workerProbeContext,
} from "../../support/worker-fixtures.js";

it.each(["codex", "devin", "claude"] as const)(
  "uses the %s Herdr integration and a pinned native resume descriptor",
  async (kind) => {
    const adapter = workerAdapters().get(kind)!;
    const prepared = await adapter.prepare(contractAssignment({ workerKind: kind }));
    expect(adapter.launchSpec(prepared)).toMatchObject({
      kind,
      cwd: prepared.assignment.worktree.path,
    });
    const launchPrompt = adapter.launchSpec(prepared).args.at(-1)!;
    expect(launchPrompt).not.toContain("\n");
    expect(launchPrompt).toContain(".harness-output/assignment.md");
    const session = nativeSessionRef(kind, prepared.assignment);
    const resumed = adapter.resumeSpec(prepared, session);
    expect(resumed).toMatchObject({ status: "supported", session });
    if (resumed.status === "supported") {
      expect(resumed.args).toContain(session.value);
    }
  },
);

it.each(["codex", "devin", "claude"] as const)(
  "probes %s executable and auth without exposing credential output",
  async (kind) => {
    const process = new FakeProcessRunner();
    process.queue({
      exitCode: 0,
      stdout: `${kind} 1.2.3\nsecret-looking-extra-line`,
      stderr: "",
    });
    process.queue({
      exitCode: 0,
      stdout: "Logged in as private@example.invalid with token abc",
      stderr: "",
    });
    const capabilities = await workerAdapters()
      .get(kind)!
      .probe(workerProbeContext(process));
    expect(capabilities).toMatchObject({
      available: true,
      launch: true,
      nativeResume: true,
      superpowers: true,
    });
    expect(capabilities.evidence.join("\n")).not.toMatch(
      /private@example|token abc|secret-looking/,
    );
  },
);

it.each(["codex", "devin", "claude"] as const)(
  "rejects same-kind %s task review",
  async (kind) => {
    const base = assignmentFixture();
    const review = createAssignment({
      ...base,
      stageId: "review",
      jobId: "review:T001",
      role: "review",
      profileId: `reviewer-${kind}`,
      profileFamily: kind,
      workerKind: kind,
      implementationProfileFamily: kind,
      implementationWorkerKind: kind,
      requiredDisciplines: ["requesting-code-review"],
      verificationCommands: [],
      worktree: {
        role: "review",
        path: "/tmp/review",
        branch: null,
        commit: base.commit,
        writable: false,
      },
    });
    await expect(workerAdapters().get(kind)!.prepare(review)).rejects.toThrow(
      /different worker kind/,
    );
  },
);

it("keeps routing priority out of the adapter registry", () => {
  expect([...workerAdapters().keys()].sort()).toEqual(["claude", "codex", "devin"]);
});

it("uses Codex headless automation without bypassing hook trust", async () => {
  const adapter = workerAdapters().get("codex")!;
  const prepared = await adapter.prepare(contractAssignment({ workerKind: "codex" }));
  const launch = adapter.launchSpec(prepared);
  expect(launch.args[0]).toBe("exec");
  expect(launch.args).toEqual(expect.arrayContaining(["--disable", "hooks"]));
  expect(launch.args).toEqual(expect.arrayContaining([
    "--config",
    'approval_policy="never"',
  ]));
  expect(launch.args).not.toContain("--ask-for-approval");
  expect(launch.args).not.toContain("--dangerously-bypass-hook-trust");
});

it("uses Devin's documented sandboxed headless trust policy", async () => {
  const adapter = workerAdapters().get("devin")!;
  const prepared = await adapter.prepare(contractAssignment({ workerKind: "devin" }));
  const launch = adapter.launchSpec(prepared);
  expect(launch.args).toEqual(expect.arrayContaining([
    "--sandbox",
    "--print",
    "--respect-workspace-trust",
    "false",
  ]));
  expect(launch.args).not.toEqual(expect.arrayContaining([
    "dangerous",
    "bypass",
  ]));
});

it.each([
  ["codex", "read-only"],
  ["devin", "auto"],
  ["claude", "plan"],
] as const)("launches %s reviewers with a non-editing permission policy", async (kind, mode) => {
  const adapter = workerAdapters().get(kind)!;
  const prepared = await adapter.prepare(contractAssignment({
    workerKind: kind,
    role: "review",
    implementationWorkerKind: kind === "codex" ? "devin" : "codex",
    worktree: {
      ...contractAssignment().worktree,
      role: "review",
      branch: null,
      writable: false,
    },
  }));
  const args = adapter.launchSpec(prepared).args;
  expect(args).toContain(mode);
  expect(args).not.toEqual(expect.arrayContaining([
    "dangerous",
    "workspace-write",
    "acceptEdits",
    "bypassPermissions",
  ]));
});
