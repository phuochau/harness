import { expect, it } from "vitest";
import type { ControllerCommand } from "../../src/contracts/controller-command.js";
import {
  harnessCommandNames,
  HarnessCommandService,
  type HarnessCommandBackend,
} from "../../src/pi/commands.js";
import { previewEffectKinds } from "../../src/pi/dependencies.js";

function fixture(confirm = true) {
  const commands: ControllerCommand[] = [];
  const notices: string[] = [];
  const backend: HarnessCommandBackend = {
    snapshot: async () => ({ runId: "F023", paused: false, jobs: { "implement:T001": "RUNNING" } }),
    graph: async () => ({ tasks: [{ id: "T001", dependsOn: [] }] }),
    logs: async (target) => [`log:${target ?? "run"}`],
    doctor: async () => ({ ready: true, summary: "ready" }),
    previewRun: async () => ({
      workflowHash: `sha256:${"a".repeat(64)}`,
      commands: { task_verify: ["npm", "test"] },
      workers: ["devin", "codex", "claude"],
      credentialProfiles: ["chatgpt-planning"],
      permissions: ["repository-write"],
      branches: ["harness/run-F023"],
      effects: ["push", "pull-request"],
    }),
    enqueue: async (command) => {
      commands.push(command);
    },
  };
  const service = new HarnessCommandService(backend, () => "command-1");
  const ui = {
    notify: (message: string) => notices.push(message),
    confirm: async () => confirm,
  };
  return { service, commands, notices, ui };
}

it("exposes every semantic harness command", () => {
  expect(harnessCommandNames).toEqual([
    "harness-run",
    "harness-status",
    "harness-graph",
    "harness-task",
    "harness-logs",
    "harness-retry",
    "harness-reroute",
    "harness-cancel",
    "harness-pause",
    "harness-resume",
    "harness-doctor",
  ]);
});

it("keeps status commands read-only and free of model calls", async () => {
  const run = fixture();
  await run.service.execute("harness-status", "", run.ui);
  await run.service.execute("harness-task", "T001", run.ui);
  expect(run.commands).toHaveLength(0);
  expect(run.notices.join("\n")).toContain("implement:T001");
});

it("shows the full run plan before enqueueing an approved operator intent", async () => {
  const run = fixture(true);
  await run.service.execute("harness-run", "F023", run.ui);
  expect(run.notices[0]).toContain("chatgpt-planning");
  expect(run.notices[0]).toContain("pull-request");
  expect(run.commands[0]).toMatchObject({
    source: "operator",
    kind: "operator_intent",
    idempotencyKey: "command-1",
    payload: { operation: "run", target: "F023" },
  });
});

it("does not enqueue a denied run and emits typed retry/reroute intents", async () => {
  const denied = fixture(false);
  await denied.service.execute("harness-run", "F023", denied.ui);
  expect(denied.commands).toHaveLength(0);

  const run = fixture();
  await run.service.execute("harness-retry", "T001", run.ui);
  await run.service.execute("harness-reroute", "T001 claude", run.ui);
  expect(run.commands.map((command) => command.payload)).toEqual([
    { operation: "retry", target: "T001", arguments: {} },
    { operation: "reroute", target: "T001", arguments: { worker: "claude" } },
  ]);
});

it("previews every distinct workflow effect before run approval", () => {
  expect(previewEffectKinds([
    { uses: "spec-kit.specify" },
    { uses: "worker.execute" },
    { uses: "command.run" },
    { uses: "worker.execute" },
    { uses: "git.push" },
    { uses: "github.pull-request" },
  ])).toEqual([
    "spec-kit.specify",
    "worker.execute",
    "command.run",
    "git.push",
    "github.pull-request",
  ]);
});
