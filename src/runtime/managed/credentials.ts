import { constants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ResolvedProfile } from "../../config/profiles.js";
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
  const home = ambient.HOME ?? homedir();
  const projected: string[] = [];
  const copy = async (source: string, target: string) => {
    if (await copyCredential(source, target)) projected.push(target);
  };
  if (input.profile.family === "codex") {
    if (input.profile.provider === "pi-shell-acp") {
      await copy(
        join(ambient.CODEX_HOME ?? join(home, ".codex"), "auth.json"),
        join(input.paths.profileHome, ".codex", "auth.json"),
      );
    } else {
      await copy(
        join(ambient.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "auth.json"),
        join(input.paths.piAgentDir, "auth.json"),
      );
    }
  } else if (input.profile.family === "devin") {
    await copy(
      join(ambient.XDG_DATA_HOME ?? join(home, ".local", "share"), "devin", "credentials.toml"),
      join(input.paths.xdgDataHome, "devin", "credentials.toml"),
    );
    await copy(
      join(ambient.XDG_CONFIG_HOME ?? join(home, ".config"), "devin", "config.json"),
      join(input.paths.xdgConfigHome, "devin", "config.json"),
    );
  } else {
    await copy(join(home, ".claude.json"), join(input.paths.profileHome, ".claude.json"));
    await copy(
      join(home, ".claude", ".credentials.json"),
      join(input.paths.profileHome, ".claude", ".credentials.json"),
    );
  }
  return projected;
}
