import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { validateEnvironmentAndLock } from "../../contracts/index.js";
import type { EnvironmentDocument } from "../../contracts/environment.js";
import type { HarnessLock } from "../../contracts/lock.js";
import type { EffectivePolicy } from "../../install/types.js";
import { OFFICIAL_NPM_REGISTRY } from "../../install/recipes.js";

const npmName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function assertNoSymlinkComponents(root: string, path: string): Promise<void> {
  const segments = relative(root, path).split(sep);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`managed package path contains a symlink: ${current}`);
    }
  }
}

export async function resolveManagedExtensions(input: {
  environment: EnvironmentDocument;
  lock: HarnessLock;
  extensionIds: readonly string[];
  packageModules: string;
  policy: EffectivePolicy;
}): Promise<Readonly<Record<string, readonly string[]>>> {
  const { environment, lock } = validateEnvironmentAndLock(input.environment, input.lock);
  const requirements = new Map(environment.pi_packages.map((item) => [item.id, item]));
  const dependencies = new Map(lock.dependencies.map((item) => [item.id, item]));
  const result: Record<string, readonly string[]> = {};
  if ((await lstat(input.packageModules)).isSymbolicLink()) {
    throw new Error("managed node_modules must not be a symlink");
  }
  const modulesReal = await realpath(input.packageModules);

  for (const id of new Set(input.extensionIds)) {
    const requirement = requirements.get(id);
    if (!requirement) throw new Error(`extension ${id} has no declared Pi package`);
    if (requirement.scope !== "managed") throw new Error(`extension ${id} must use managed package scope`);
    const dependency = dependencies.get(requirement.dependency);
    if (!dependency || dependency.kind !== "pi-package" || dependency.source.kind !== "npm") {
      throw new Error(`extension ${id} needs a locked npm Pi package dependency`);
    }
    const source = dependency.source;
    if (!npmName.test(source.identity) || source.identity.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`extension ${id} has unsafe npm package identity ${source.identity}`);
    }
    if (!input.policy.allows({ kind: "npm", identity: source.identity, version: source.version,
      integrity: source.integrity, registry: OFFICIAL_NPM_REGISTRY })) {
      throw new Error(`extension ${id} npm source is not allowed by release policy`);
    }
    const packageRoot = join(input.packageModules, source.identity);
    await assertNoSymlinkComponents(input.packageModules, packageRoot);
    const packageReal = await realpath(packageRoot);
    if (!inside(modulesReal, packageReal)) throw new Error(`extension ${id} package escapes managed node_modules`);
    const manifestPath = join(packageRoot, "package.json");
    await assertNoSymlinkComponents(packageRoot, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: string; version?: string };
    if (manifest.name !== source.identity || manifest.version !== source.version) {
      throw new Error(`extension ${id} installed package name/version differs from lock`);
    }
    const declared = requirement.resources.extensions;
    if (!declared?.length) throw new Error(`extension ${id} declares no entrypoints`);
    const paths: string[] = [];
    for (const entry of declared) {
      if (isAbsolute(entry) || entry.split(/[\\/]/).some((part) => part === "." || part === ".." || !part)) {
        throw new Error(`unsafe extension entrypoint path: ${entry}`);
      }
      const entryPath = join(packageRoot, entry);
      await assertNoSymlinkComponents(packageRoot, entryPath);
      const entryReal = await realpath(entryPath);
      if (!inside(packageReal, entryReal) || !(await stat(entryPath)).isFile()) {
        throw new Error(`extension ${id} entrypoint is not a regular file inside package: ${entry}`);
      }
      paths.push(entryPath);
    }
    result[id] = Object.freeze(paths);
  }
  return Object.freeze(result);
}
