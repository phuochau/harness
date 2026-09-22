import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResolvedProfile } from "../../config/profiles.js";
import { providerIntegration } from "../../providers/registry.js";
import type { ManagedRuntimePaths } from "./paths.js";

async function copyCredential(source: string, target: string): Promise<boolean> {
  try {
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.size > 1024 * 1024) {
      throw new Error(`subscription credential is not a bounded regular file: ${source}`);
    }
    try {
      const targetInfo = await lstat(target);
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
        throw new Error(`managed credential target is unsafe: ${target}`);
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function projectLocalSubscriptionCredentials(input: {
  readonly profile: ResolvedProfile;
  readonly paths: ManagedRuntimePaths;
  readonly ambient?: Readonly<Record<string, string | undefined>>;
}): Promise<readonly string[]> {
  const ambient = input.ambient ?? process.env;
  const projected: string[] = [];
  for (const { source, target } of providerIntegration(input.profile).credentialFiles({
    profile: input.profile, paths: input.paths, ambient,
  })) {
    if (await copyCredential(source, target)) projected.push(target);
  }
  return projected;
}
