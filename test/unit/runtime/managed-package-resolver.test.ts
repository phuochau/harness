import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EnvironmentDocument } from "../../../src/contracts/environment.js";
import type { HarnessLock } from "../../../src/contracts/lock.js";
import { effectivePolicy } from "../../../src/install/policy.js";
import { resolveManagedExtensions } from "../../../src/runtime/managed/package-resolver.js";

const source = { kind: "npm" as const, identity: "@example/bridge", version: "1.2.3", integrity: "sha512-test" };
const environment = (): EnvironmentDocument => ({
  schema: "harness/environment/v1", commands: {}, pi_packages: [{
    id: "bridge", dependency: "bridge-dep", scope: "managed",
    resources: { extensions: ["src/b.js", "src/a.js"] },
  }],
});
const lock = (): HarnessLock => ({
  schema: "harness/lock/v1", harnessVersion: "0.1.0", dependencies: [{
    id: "bridge-dep", kind: "pi-package", version: "1.2.3", source,
    piSource: "npm:@example/bridge@1.2.3", dependsOn: [],
  }],
});
const policy = effectivePolicy({ allow: [{ ...source, registry: "https://registry.npmjs.org/" }] }, undefined, {});

describe("managed extension resolution", () => {
  let root: string;
  let modules: string;
  let packageRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-ext-"));
    modules = join(root, "node_modules");
    packageRoot = join(modules, "@example", "bridge");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: source.identity, version: source.version }));
    await writeFile(join(packageRoot, "src/a.js"), "export {};");
    await writeFile(join(packageRoot, "src/b.js"), "export {};");
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const resolve = (env = environment(), locked = lock(), trusted = policy) =>
    resolveManagedExtensions({ environment: env, lock: locked, extensionIds: ["bridge"], packageModules: modules, policy: trusted });

  it("returns multiple declared entrypoints in declaration order", async () => {
    const result = await resolve();
    expect(result.bridge).toEqual([join(packageRoot, "src/b.js"), join(packageRoot, "src/a.js")]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bridge)).toBe(true);
  });

  it.each(["../outside.js", "/tmp/outside.js", "src/../a.js"])("rejects unsafe path %s", async (path) => {
    const env = environment();
    env.pi_packages[0]!.resources.extensions = [path];
    await expect(resolve(env)).rejects.toThrow(/unsafe|path/i);
  });

  it("rejects a symlinked package root or scoped parent", async () => {
    await rm(packageRoot, { recursive: true });
    await symlink(root, packageRoot);
    await expect(resolve()).rejects.toThrow(/symlink|outside|package/i);
    await rm(packageRoot);
    await rm(join(modules, "@example"), { recursive: true });
    await symlink(root, join(modules, "@example"));
    await expect(resolve()).rejects.toThrow(/symlink|outside|package/i);
  });

  it("rejects a symlinked managed node_modules directory", async () => {
    const moved = join(root, "elsewhere");
    await rename(modules, moved);
    await symlink(moved, modules);
    await expect(resolve()).rejects.toThrow(/symlink|outside/i);
  });

  it("rejects a symlinked entrypoint", async () => {
    await rm(join(packageRoot, "src/b.js"));
    await symlink(join(root, "outside.js"), join(packageRoot, "src/b.js"));
    await expect(resolve()).rejects.toThrow(/symlink|outside|entrypoint/i);
  });

  it.each([{ name: "wrong", version: "1.2.3" }, { name: source.identity, version: "9.9.9" }])(
    "rejects installed package identity mismatch %j", async (identity) => {
      await writeFile(join(packageRoot, "package.json"), JSON.stringify(identity));
      await expect(resolve()).rejects.toThrow(/name|version|identity/i);
    },
  );

  it("rejects a missing declared entrypoint", async () => {
    await rm(join(packageRoot, "src/b.js"));
    await expect(resolve()).rejects.toThrow(/b\.js|entrypoint/i);
  });

  it("rejects missing lock mapping and duplicate IDs", async () => {
    await expect(resolve(environment(), { ...lock(), dependencies: [] })).rejects.toThrow(/lock dependency/i);
    const env = environment();
    env.pi_packages.push({ ...env.pi_packages[0]! });
    await expect(resolve(env)).rejects.toThrow(/unique|duplicate/i);
  });

  it("rejects project scope and unlisted sources", async () => {
    const env = environment();
    env.pi_packages[0]!.scope = "project";
    await expect(resolve(env)).rejects.toThrow(/managed|scope/i);
    await expect(resolve(environment(), lock(), effectivePolicy({ allow: [] }, undefined, {})))
      .rejects.toThrow(/allow|policy|approved/i);
  });
});
