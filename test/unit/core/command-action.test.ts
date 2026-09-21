import { expect, it, vi } from "vitest";
import {
  CommandAction,
  type CommandInput,
} from "../../../src/actions/command.js";
import type {
  ActionContext,
  EffectIntent,
} from "../../../src/actions/types.js";
import {
  actionContext,
  recoveryContext,
} from "../../support/state-fixtures.js";
import { FakeProcessRunner } from "../../support/fake-process.js";

function intent(input: CommandInput): EffectIntent<"command.run", CommandInput> {
  return {
    action: "command.run",
    idempotencyKey: "command:verify:T001",
    recovery: input.probe ? "reconcilable" : "non_retryable",
    laneKey: "verification:T001",
    input,
  };
}

it("blocks recovery of an unobserved command without a probe", async () => {
  const handler = new CommandAction();
  await expect(
    handler.reconcile(recoveryContext(), intent({ argv: ["npm", "test"] })),
  ).resolves.toEqual({
    status: "indeterminate",
    evidence: ["command has no reconciliation probe"],
  });
});

it("runs verification only in a worktree pinned to the intended commit", async () => {
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "ok", stderr: "" });
  const assertWorktreeCommit = vi.fn(async () => undefined);
  const context: ActionContext = {
    ...actionContext(),
    process,
    git: { ...actionContext().git, assertWorktreeCommit },
  };
  const handler = new CommandAction();
  const command = intent({
    argv: ["npm", "test"],
    cwd: "/tmp/detached verification",
    expectedCommit: "abc123",
  });
  await expect(handler.execute(context, command)).resolves.toEqual({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  expect(assertWorktreeCommit).toHaveBeenCalledWith(
    "/tmp/detached verification",
    "abc123",
  );
  expect(process.calls[0]?.options.cwd).toBe("/tmp/detached verification");

  assertWorktreeCommit.mockRejectedValueOnce(new Error("moved"));
  await expect(
    handler.execute(context, {
      ...command,
      input: { ...command.input, expectedCommit: "moved" },
    }),
  ).rejects.toThrow(/verification worktree commit mismatch/);
});

it("uses a shell-free declared probe during reconciliation", async () => {
  const process = new FakeProcessRunner();
  process.queue({ exitCode: 0, stdout: "present", stderr: "" });
  const context: ActionContext = { ...recoveryContext(), process };
  const handler = new CommandAction();
  const command = intent({
    argv: ["npm", "run", "verify"],
    cwd: "/tmp/project with spaces",
    probe: ["test", "-f", "receipt.json"],
  });
  await expect(handler.reconcile(context, command)).resolves.toEqual({
    status: "observed",
    output: { exitCode: 0, stdout: "present", stderr: "" },
  });
  expect(process.calls[0]).toMatchObject({
    executable: "test",
    argv: ["-f", "receipt.json"],
    options: { cwd: "/tmp/project with spaces", shell: false },
  });
});

it("requires cwd when verification is pinned to a commit", async () => {
  const handler = new CommandAction();
  await expect(
    handler.execute(
      actionContext(),
      intent({ argv: ["npm", "test"], expectedCommit: "abc123" }),
    ),
  ).rejects.toThrow(/expectedCommit requires cwd/);
});

