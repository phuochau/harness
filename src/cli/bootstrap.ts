import type { ProcessRunner } from "../actions/types.js";
import type { EnvironmentDocument } from "../contracts/index.js";
import { executeInstallPlan, type InstallApproval } from "../install/executor.js";
import { mergePiPackageSettings } from "../install/pi-settings.js";
import { createInstallPlan, type AutomaticInstallStep, type InstallPlan } from "../install/plan.js";
import { effectivePolicy } from "../install/policy.js";
import type { ReceiptStore } from "../install/receipts.js";
import type {
  CapabilityReport,
  ProbeResult,
  TrustedSource,
  TrustPolicy,
} from "../install/types.js";
import { OFFICIAL_NPM_REGISTRY } from "../install/recipes.js";
import { doctor, type DoctorReport } from "./doctor.js";
import {
  assertLauncherMatchesLock,
  readDeclarativeProject,
  type DeclarativeProject,
} from "./trusted-project-reader.js";

export interface BootstrapOptions {
  readonly root: string;
  readonly dryRun?: boolean;
  readonly repair?: boolean;
  readonly yes?: boolean;
}

export interface BootstrapDependencies {
  readonly baseline: TrustPolicy;
  readonly machinePolicy?: TrustPolicy;
  readonly probe: (project: DeclarativeProject) => Promise<CapabilityReport>;
  readonly resolveSource?: (source: TrustedSource) => Promise<TrustedSource>;
  readonly presenter: { show(plan: InstallPlan): Promise<void> };
  readonly approvals: {
    requirePlanHash(planHash: string, yes: boolean): Promise<InstallApproval>;
  };
  readonly executor: {
    readonly process: ProcessRunner;
    readonly receipts: ReceiptStore;
    readonly verifySource: (step: AutomaticInstallStep) => Promise<boolean>;
    readonly afterInstall?: (step: AutomaticInstallStep) => Promise<void>;
    readonly verifyLoaded?: (step: AutomaticInstallStep) => Promise<boolean>;
  };
}

export type BootstrapResult =
  | { readonly status: "planned"; readonly plan: InstallPlan }
  | { readonly status: "installed"; readonly plan: InstallPlan; readonly report: DoctorReport };

type PiPackageRequirement = EnvironmentDocument["pi_packages"][number];

function piRequirement(project: DeclarativeProject, stepId: string): PiPackageRequirement | undefined {
  return project.environment.pi_packages.find((item) => item.dependency === stepId);
}

function probeResult(
  project: DeclarativeProject,
  report: CapabilityReport,
  id: string,
): ProbeResult {
  const direct = report.byId[id];
  if (direct !== undefined) return direct;
  const requirement = piRequirement(project, id);
  return requirement === undefined
    ? { id, status: "missing" }
    : report.byId[`pi-package:${requirement.id}`] ?? { id, status: "missing" };
}

async function configurePiPackage(
  project: DeclarativeProject,
  step: AutomaticInstallStep,
  repair: boolean,
): Promise<void> {
  const requirement = piRequirement(project, step.id);
  if (requirement === undefined) return;
  const dependency = project.lock.dependencies.find((item) => item.id === step.id)!;
  const resources = requirement.resources;
  const previousPackages = Array.isArray(project.piSettings.packages)
    ? project.piSettings.packages
    : [];
  const existedBeforeInstall = previousPackages.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as { source?: unknown }).source === dependency.piSource,
  );
  await mergePiPackageSettings({
    root: project.root,
    declaredSources: project.environment.pi_packages.map((item) =>
      project.lock.dependencies.find((dependency) => dependency.id === item.dependency)!.piSource!,
    ),
    entry: {
      source: dependency.piSource!,
      extensions: (resources.extensions ?? []).map((path) => `+${path}`),
      skills: (resources.skills ?? []).map((path) => `+${path}`),
      prompts: (resources.prompts ?? []).map((path) => `+${path}`),
      themes: (resources.themes ?? []).map((path) => `+${path}`),
    },
    repair: repair || !existedBeforeInstall,
  });
}

export async function bootstrap(
  options: BootstrapOptions,
  dependencies: BootstrapDependencies,
): Promise<BootstrapResult> {
  const project = await readDeclarativeProject(options.root);
  assertLauncherMatchesLock(project.lock);
  const initialReport = await dependencies.probe(project);
  const resolvedDependencies = await Promise.all(
    project.lock.dependencies.map(async (dependency) => {
      if (dependency.source.kind === "manual" || dependencies.resolveSource === undefined) {
        return dependency;
      }
      const declared: TrustedSource = {
        kind: dependency.source.kind,
        identity: dependency.source.identity,
        version: dependency.source.version,
        integrity: dependency.source.integrity,
        ...(dependency.source.kind === "npm"
          ? { registry: OFFICIAL_NPM_REGISTRY }
          : {}),
      };
      const resolved = await dependencies.resolveSource(declared);
      if (
        resolved.kind !== declared.kind ||
        resolved.identity !== declared.identity ||
        resolved.version !== declared.version
      ) {
        throw new Error(`resolved source identity drift for ${dependency.id}`);
      }
      return { ...dependency, source: resolved };
    }),
  );
  const resolvedLock = { ...project.lock, dependencies: resolvedDependencies };
  const policy = effectivePolicy(
    dependencies.baseline,
    dependencies.machinePolicy,
    project.projectPolicy,
  );
  const plan = createInstallPlan(resolvedLock, initialReport, policy, {
    repair: options.repair === true,
  });
  await dependencies.presenter.show(plan);
  if (options.dryRun === true) return { status: "planned", plan };

  const approval = await dependencies.approvals.requirePlanHash(plan.planHash, options.yes === true);
  await executeInstallPlan(plan, approval, {
    root: project.root,
    process: dependencies.executor.process,
    receipts: dependencies.executor.receipts,
    verifySource: dependencies.executor.verifySource,
    probe: async (id) => probeResult(project, await dependencies.probe(project), id),
    afterInstall: async (step) => {
      await dependencies.executor.afterInstall?.(step);
      await configurePiPackage(project, step, options.repair === true);
    },
    ...(dependencies.executor.verifyLoaded === undefined
      ? {}
      : { verifyLoaded: dependencies.executor.verifyLoaded }),
  });
  return {
    status: "installed",
    plan,
    report: await doctor({ root: project.root }, { probe: dependencies.probe }),
  };
}
