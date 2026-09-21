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
  readonly afterInstall?: (step: AutomaticInstallStep) => Promise<void>;
  readonly verifyLoaded?: (step: AutomaticInstallStep) => Promise<boolean>;
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
    let sourceVerified = false;
    try {
      sourceVerified = await dependencies.verifySource(step);
    } catch {
      sourceVerified = false;
    }
    if (!sourceVerified) {
      await failed(dependencies.receipts, plan.planHash, step.id, "source verification failed");
      throw new InstallVerificationError(`source verification failed for ${step.id}`);
    }

    let result: Awaited<ReturnType<ProcessRunner["run"]>>;
    try {
      result = await dependencies.process.run(step.executable, step.argv, {
        cwd: dependencies.root,
        ...(step.environment === undefined ? {} : { env: step.environment }),
        shell: false,
        timeoutMs: 120_000,
      });
    } catch {
      await failed(dependencies.receipts, plan.planHash, step.id, "installer process failed");
      throw new InstallExecutionError(`installation failed for ${step.id}`);
    }
    if (result.exitCode !== 0) {
      await failed(dependencies.receipts, plan.planHash, step.id, "installer exited non-zero");
      throw new InstallExecutionError(`installation failed for ${step.id}`);
    }

    try {
      await dependencies.afterInstall?.(step);
    } catch {
      await failed(dependencies.receipts, plan.planHash, step.id, "post-install configuration failed");
      throw new InstallVerificationError(`post-install configuration failed for ${step.id}`);
    }

    let observed: ProbeResult;
    try {
      observed = await dependencies.probe(step.probeAfter);
    } catch {
      await failed(dependencies.receipts, plan.planHash, step.id, "post-install probe failed");
      throw new InstallVerificationError(`post-install verification failed for ${step.id}`);
    }
    if (observed.status !== "present" || observed.version !== step.expectedVersion) {
      await failed(dependencies.receipts, plan.planHash, step.id, "post-install probe mismatch");
      throw new InstallVerificationError(`post-install verification failed for ${step.id}`);
    }
    let loaded = true;
    try {
      loaded = dependencies.verifyLoaded === undefined || await dependencies.verifyLoaded(step);
    } catch {
      loaded = false;
    }
    if (!loaded) {
      await failed(dependencies.receipts, plan.planHash, step.id, "isolated loader verification failed");
      throw new InstallVerificationError(`isolated loader verification failed for ${step.id}`);
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
