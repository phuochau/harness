import type { ProcessRunner } from "../actions/types.js";
import type { ProbeResult } from "./types.js";
import { installPlanHash, type AutomaticInstallStep, type InstallPlan } from "./plan.js";
import type { ReceiptStore } from "./receipts.js";

export class InstallApprovalError extends Error {}
export class ManualInstallRequiredError extends Error {}
export class InstallExecutionError extends Error {}
export class InstallVerificationError extends Error {}

export interface InstallApproval {
  readonly approved: boolean;
  readonly planHash: string;
}

export interface InstallExecutorDependencies {
  readonly root: string;
  readonly process: ProcessRunner;
  readonly probe: (id: string) => Promise<ProbeResult>;
  readonly receipts: ReceiptStore;
  readonly verifySource: (step: AutomaticInstallStep) => Promise<boolean>;
}

async function failed(
  receipts: ReceiptStore,
  planHash: string,
  stepId: string,
  reason: string,
): Promise<void> {
  await receipts.append({
    schemaVersion: 1,
    planHash,
    stepId,
    status: "failed",
    reason,
    recordedAt: new Date().toISOString(),
  });
}

function assertRecipeInvariant(step: AutomaticInstallStep): void {
  if (step.executable === "npm" && !step.argv.includes("--ignore-scripts")) {
    throw new InstallExecutionError(`npm recipe ${step.id} may execute lifecycle scripts`);
  }
  if (step.argv.some((argument) => argument.includes("\0"))) {
    throw new InstallExecutionError(`recipe ${step.id} contains an invalid argument`);
  }
}

export async function executeInstallPlan(
  plan: InstallPlan,
  approval: InstallApproval,
  dependencies: InstallExecutorDependencies,
): Promise<void> {
  const { planHash: claimedHash, ...body } = plan;
  if (
    installPlanHash(body) !== claimedHash ||
    !approval.approved ||
    approval.planHash !== claimedHash
  ) {
    throw new InstallApprovalError("approval does not match the exact install plan hash");
  }
  const blocker = plan.steps.find((step) => step.mode === "manual" && step.blocking);
  if (blocker !== undefined) {
    throw new ManualInstallRequiredError(`manual installation required for ${blocker.id}`);
  }

  for (const step of plan.steps) {
    if (step.mode !== "automatic") continue;
    if (await dependencies.receipts.completed(plan.planHash, step.id)) continue;
    assertRecipeInvariant(step);
    if (!(await dependencies.verifySource(step))) {
      await failed(dependencies.receipts, plan.planHash, step.id, "source verification failed");
      throw new InstallVerificationError(`source verification failed for ${step.id}`);
    }

    const result = await dependencies.process.run(step.executable, step.argv, {
      cwd: dependencies.root,
      shell: false,
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      await failed(dependencies.receipts, plan.planHash, step.id, "installer exited non-zero");
      throw new InstallExecutionError(`installation failed for ${step.id}`);
    }

    const observed = await dependencies.probe(step.probeAfter);
    if (observed.status !== "present" || observed.version !== step.expectedVersion) {
      await failed(dependencies.receipts, plan.planHash, step.id, "post-install probe mismatch");
      throw new InstallVerificationError(`post-install verification failed for ${step.id}`);
    }
    await dependencies.receipts.append({
      schemaVersion: 1,
      planHash: plan.planHash,
      stepId: step.id,
      status: "completed",
      version: observed.version,
      recordedAt: new Date().toISOString(),
    });
  }
}
