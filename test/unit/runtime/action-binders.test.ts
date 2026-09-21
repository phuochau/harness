import { expect, it } from "vitest";
import type { EffectIntent } from "../../../src/actions/types.js";
import { initialRunState } from "../../../src/core/state.js";
import { ProductionActionBinders } from "../../../src/runtime/production/action-binders.js";

it("preserves a command reconciliation probe in the production binding", async () => {
  const workspace = {
    id: "verify:F023",
    runId: "F023",
    role: "verification" as const,
    path: "/repo/verification",
    branch: null,
    commit: "a".repeat(40),
    baseCommit: "a".repeat(40),
    writable: false,
    ownedPaths: [],
    artifactPaths: [],
  };
  const binders = new ProductionActionBinders({
    manifest: { runId: "F023", runRef: "refs/heads/harness/run-F023" } as any,
    repository: { revParse: async () => workspace.commit } as any,
    worktrees: { openVerification: async () => workspace } as any,
    records: {} as any,
    readState: async () => initialRunState("F023", `sha256:${"b".repeat(64)}`),
    tasksSemanticHash: () => `sha256:${"c".repeat(64)}`,
  });
  const intent: EffectIntent<"command.run", Readonly<Record<string, unknown>>> = {
    action: "command.run",
    idempotencyKey: "command.run:final_verify:1",
    recovery: "reconcilable",
    laneKey: "job:final_verify",
    input: {
      stageId: "final_verify",
      attempt: 1,
      argv: ["npm", "test"],
      probe: ["test", "-f", ".verified"],
    },
  };

  await expect(binders.command(intent)).resolves.toMatchObject({
    argv: ["npm", "test"],
    probe: ["test", "-f", ".verified"],
    cwd: workspace.path,
    expectedCommit: workspace.commit,
  });
});
