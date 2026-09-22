import type { ResolvedProfile } from "../config/profiles.js";
import type { ManagedProfileView } from "../runtime/managed/materialize.js";
import type { ManagedRuntimePaths } from "../runtime/managed/paths.js";
import type { PiIntegrationId } from "./identity.js";

export interface ProfileAuthCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export interface AuthInput {
  readonly profile: ResolvedProfile;
  readonly managedEnvironment: Readonly<Record<string, string>>;
  readonly piExecutable: string;
  readonly managedExtensionPaths?: readonly string[];
  readonly codexExecutable?: string;
  readonly devinExecutable?: string;
  readonly claudeExecutable?: string;
}
export interface AuthProbeInput extends AuthInput {
  readonly piExecutableArgs: readonly string[];
}
export interface AuthProbeCommand extends ProfileAuthCommand {
  isAuthenticated(stdout: string, stderr: string, exitCode: number): boolean;
}
export interface CredentialInput {
  readonly profile: ResolvedProfile;
  readonly paths: ManagedRuntimePaths;
  readonly ambient: Readonly<Record<string, string | undefined>>;
}
export interface CredentialFile { readonly source: string; readonly target: string }
export type ProviderSkillProjection =
  | { readonly kind: "none" }
  | { readonly kind: "copy-home"; readonly directory: string }
  | { readonly kind: "inline"; readonly id: string; readonly content: string };
export interface ProviderSkillInput {
  readonly paths: ManagedRuntimePaths;
  readonly name: string;
  readonly id: string;
  readonly content: string;
}
export interface ProviderSettingsInput {
  readonly paths: ManagedRuntimePaths;
  readonly forwardedSkills: readonly { id: string; content: string }[];
}
export interface ProviderSettingsFile { readonly path: string; readonly content: string }
export interface ProviderVerificationInput {
  readonly profile: ResolvedProfile;
  readonly managed: ManagedProfileView;
}
export interface PiProviderAdapter {
  readonly id: PiIntegrationId;
  authCommand(input: AuthInput): ProfileAuthCommand;
  authProbe(input: AuthProbeInput): AuthProbeCommand;
  credentialFiles(input: CredentialInput): readonly CredentialFile[];
  providerSkillProjection(input: ProviderSkillInput): ProviderSkillProjection;
  environment(input: { profile: ResolvedProfile }): Readonly<Record<string, string>>;
  settings(input: ProviderSettingsInput): readonly ProviderSettingsFile[];
  verifyManaged(input: ProviderVerificationInput): Promise<{ verified: boolean; evidence: readonly string[] }>;
  recoverProviderSession(input: { piSessionId: string; providerSessionId: string }):
    { status: "retry"; reason: string } | { status: "resume"; sessionId: string };
}

export function authStatus(stdout: string, stderr: string, exitCode: number): boolean {
  if (exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(stdout) as { status?: string; loggedIn?: boolean };
    return parsed.status === "ready" || parsed.loggedIn === true;
  } catch {
    const message = `${stdout}\n${stderr}`;
    return !/not logged in|logged in\s*:\s*false/i.test(message) &&
      /^\s*logged in(?:\s|\(|$)/im.test(message);
  }
}

export const noProjection = { kind: "none" } as const;
export const noVerification = async () => ({ verified: true, evidence: [] as string[] });
export const retryWithoutProcess = () => ({ status: "retry" as const, reason: "Pi process is no longer observable" });
