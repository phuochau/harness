import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  validateEnvironmentAndLock,
  validateProfiles,
  validateWorkflow,
  type EnvironmentDocument,
  type HarnessLock,
  type ProfileDocument,
  type WorkflowDocument,
} from "../contracts/index.js";
import type { TrustPolicy } from "../install/types.js";

const MAX_DECLARATIVE_BYTES = 1024 * 1024;

export const ALLOWED_PRE_APPROVAL_PATHS = [
  ".harness/workflow.yaml",
  ".harness/profiles.yaml",
  ".harness/environment.yaml",
  ".harness/policy.yaml",
  ".harness/harness.lock",
  ".pi/settings.json",
] as const;

export interface DeclarativeProject {
  readonly root: string;
  readonly workflow: WorkflowDocument;
  readonly profiles: ProfileDocument;
  readonly environment: EnvironmentDocument;
  readonly lock: HarnessLock;
  readonly projectPolicy: TrustPolicy;
  readonly piSettings: Readonly<Record<string, unknown>>;
}

export class TrustedProjectReadError extends Error {}

async function boundedRegularFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_DECLARATIVE_BYTES) {
    throw new TrustedProjectReadError(`declarative input is not a bounded regular file: ${path}`);
  }
  return readFile(path, "utf8");
}

async function assertDirectoryNotSymlink(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TrustedProjectReadError(`declarative input parent is not a real directory: ${path}`);
  }
}

function parseProjectPolicy(value: unknown): TrustPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TrustedProjectReadError("project policy must be an object");
  }
  const policy = value as Record<string, unknown>;
  if (policy.schema !== "harness/policy/v1") {
    throw new TrustedProjectReadError("unsupported project policy schema");
  }
  const install = policy.install;
  if (install === undefined) return {};
  if (typeof install !== "object" || install === null || Array.isArray(install)) {
    throw new TrustedProjectReadError("project install policy must be an object");
  }
  const deny = (install as { deny?: unknown }).deny;
  if (deny === undefined) return {};
  if (!Array.isArray(deny)) {
    throw new TrustedProjectReadError("project install deny policy must be an array");
  }
  return {
    deny: deny.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        !["npm", "git", "formula", "signed-artifact"].includes(
          (item as { kind?: string }).kind ?? "",
        ) ||
        typeof (item as { identity?: unknown }).identity !== "string"
      ) {
        throw new TrustedProjectReadError("invalid project install deny selector");
      }
      return item as NonNullable<TrustPolicy["deny"]>[number];
    }),
  };
}

export async function readDeclarativeProject(rootInput: string): Promise<DeclarativeProject> {
  let root: string;
  try {
    root = await realpath(rootInput);
  } catch (error) {
    throw new TrustedProjectReadError(
      `project root is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await Promise.all([
    assertDirectoryNotSymlink(join(root, ".harness")),
    assertDirectoryNotSymlink(join(root, ".pi")),
  ]);
  const [workflowText, profilesText, environmentText, policyText, lockText, settingsText] =
    await Promise.all(
      ALLOWED_PRE_APPROVAL_PATHS.map((path) => boundedRegularFile(join(root, path))),
    );
  try {
    const workflow = validateWorkflow(parse(workflowText!));
    const profiles = validateProfiles(parse(profilesText!));
    const { environment, lock } = validateEnvironmentAndLock(
      parse(environmentText!),
      parse(lockText!),
    );
    const settings: unknown = JSON.parse(settingsText!);
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      throw new Error("Pi settings must be an object");
    }
    return {
      root,
      workflow,
      profiles,
      environment,
      lock,
      projectPolicy: parseProjectPolicy(parse(policyText!)),
      piSettings: settings as Readonly<Record<string, unknown>>,
    };
  } catch (error) {
    if (error instanceof TrustedProjectReadError) throw error;
    throw new TrustedProjectReadError(
      `invalid declarative project: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function assertLauncherMatchesLock(lock: HarnessLock, launcherVersion = "0.1.0"): void {
  if (lock.harnessVersion !== launcherVersion) {
    throw new TrustedProjectReadError(
      `launcher ${launcherVersion} does not match locked harness ${lock.harnessVersion}`,
    );
  }
}
