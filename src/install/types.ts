import type { ProcessRunner } from "../actions/types.js";

export interface TrustedSource {
  readonly kind: "npm" | "git" | "formula" | "signed-artifact";
  readonly identity: string;
  readonly version: string;
  readonly integrity: string;
  readonly registry?: string;
}

export interface SourceSelector {
  readonly kind: TrustedSource["kind"];
  readonly identity: string;
}

export interface TrustPolicy {
  readonly allow?: readonly TrustedSource[];
  readonly deny?: readonly SourceSelector[];
}

export interface EffectivePolicy {
  allows(source: TrustedSource): boolean;
}

export type ProbeStatus =
  | "present"
  | "missing"
  | "wrong_version"
  | "missing_auth"
  | "disabled"
  | "wrong_source"
  | "unexpected"
  | "policy_violation"
  | "unverifiable";

export interface ProbeResult {
  readonly id: string;
  readonly status: ProbeStatus;
  readonly version?: string;
  readonly evidence?: readonly string[];
  readonly missingResources?: readonly string[];
}

export interface CapabilityReport {
  readonly byId: Readonly<Record<string, ProbeResult>>;
}

export interface ExecutableCapability {
  readonly id: string;
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly expectedVersion?: string;
  parseVersion(stdout: string): string | undefined;
  readonly auth?: {
    readonly args: readonly string[];
    isAuthenticated(stdout: string, stderr: string): boolean;
  };
}

export interface ProbeEnvironmentContext {
  readonly root: string;
  readonly process: ProcessRunner;
  readonly capabilities: readonly ExecutableCapability[];
  readonly managedPackagesRoot?: string;
  readonly machineSettingsPath?: string;
  readonly allowMachinePackageCommand?: (argv: readonly string[]) => boolean;
}
