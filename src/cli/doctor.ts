import type { LockedDependency } from "../contracts/lock.js";
import type { CapabilityReport, ProbeResult, ProbeStatus } from "../install/types.js";
import { readDeclarativeProject, type DeclarativeProject } from "./trusted-project-reader.js";

export interface DoctorOptions {
  readonly root: string;
}

export interface DoctorDependencies {
  readonly probe: (project: DeclarativeProject) => Promise<CapabilityReport>;
  readonly now?: () => Date;
}

export interface DoctorCapability {
  readonly id: string;
  readonly status: ProbeStatus;
  readonly installedVersion?: string;
  readonly requiredVersion?: string;
  readonly source?: string;
  readonly evidence?: readonly string[];
  readonly repair?: string;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly capabilities: readonly DoctorCapability[];
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|password|secret|authorization)=\S+/gi, "$1=[REDACTED]")
    .replace(/:\/\/[^/@\s]+@/g, "://[REDACTED]@");
}

function safeSource(dependency: LockedDependency): string {
  return redact(`${dependency.source.kind}:${dependency.source.identity}@${dependency.source.version}`);
}

function resultForDependency(
  project: DeclarativeProject,
  report: CapabilityReport,
  dependency: LockedDependency,
): ProbeResult | undefined {
  const direct = report.byId[dependency.id];
  if (direct !== undefined) return direct;
  const requirement = project.environment.pi_packages.find(
    (item) => item.dependency === dependency.id,
  );
  return requirement === undefined ? undefined : report.byId[`pi-package:${requirement.id}`];
}

function requiredCapability(
  project: DeclarativeProject,
  report: CapabilityReport,
  dependency: LockedDependency,
): DoctorCapability {
  const result = resultForDependency(project, report, dependency) ?? {
    id: dependency.id,
    status: "missing" as const,
  };
  return {
    id: dependency.id,
    status: result.status,
    ...(result.version === undefined ? {} : { installedVersion: result.version }),
    requiredVersion: dependency.version,
    source: safeSource(dependency),
    ...(result.evidence === undefined ? {} : { evidence: result.evidence.map(redact) }),
    ...(result.status === "present"
      ? {}
      : { repair: `Run harness bootstrap ${project.root} and approve the exact plan hash.` }),
  };
}

export async function doctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorReport> {
  const project = await readDeclarativeProject(options.root);
  const probes = await dependencies.probe(project);
  const required = project.lock.dependencies.map((dependency) =>
    requiredCapability(project, probes, dependency),
  );
  const claimed = new Set(required.map((item) => item.id));
  const supplemental: DoctorCapability[] = Object.values(probes.byId)
    .filter((result) => !claimed.has(result.id) && !result.id.startsWith("pi-package:"))
    .map((result) => ({
      id: result.id,
      status: result.status,
      ...(result.version === undefined ? {} : { installedVersion: result.version }),
      ...(result.evidence === undefined ? {} : { evidence: result.evidence.map(redact) }),
      ...(result.status === "present" ? {} : { repair: `Resolve ${result.id} and rerun harness doctor.` }),
    }));
  const capabilities = [...required, ...supplemental];
  return {
    schemaVersion: 1,
    ok: capabilities.every((item) => item.status === "present"),
    checkedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    capabilities,
  };
}
