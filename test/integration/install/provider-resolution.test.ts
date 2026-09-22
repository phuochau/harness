import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { ProfileDocument } from "../../../src/contracts/profiles.js";
import type { EnvironmentDocument } from "../../../src/contracts/environment.js";
import type { HarnessLock } from "../../../src/contracts/lock.js";
import { createManagedPiRuntime, createManagedPiRuntimeFromResolved } from "../../../src/runtime/managed/factory.js";
import { managedPackagesPath } from "../../../src/runtime/managed/paths.js";
import { buildPiLaunchSpec } from "../../../src/runtime/pi-worker/launch-spec.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const dataHome = await mkdtemp(join(tmpdir(), "harness-provider-resolution-"));
  temporary.push(dataHome);
  const packageRoot = process.cwd();
  const defaults = parse(await readFile(join(packageRoot, "src/defaults/harness.lock"), "utf8")) as HarnessLock;
  const dependency = defaults.dependencies.find((item) => item.id === "pi-devin-acp")!;
  const lock: HarnessLock = { ...defaults, dependencies: [dependency] };
  const environment: EnvironmentDocument = {
    schema: "harness/environment/v1", commands: {}, pi_packages: [{
      id: "devin-acp", dependency: "pi-devin-acp", scope: "managed",
      resources: { extensions: ["dist/custom.js"] },
    }],
  };
  const profiles: ProfileDocument = {
    schema: "harness/profiles/v1", profiles: {
      "implementer-research": {
        family: "research-agent", integration: "pi-native", runtime: "pi",
        provider: "openai-codex", model: "openai-codex/gpt-5.6-luna",
        role: "implementation", environment: "isolated", tools: ["read"],
        extensions: ["devin-acp"], skills: [], context_files: false,
        prompt_templates: [], mcp: [],
      },
    },
  };
  const packages = managedPackagesPath({ dataHome, runtimeVersion: lock.harnessVersion });
  const packagePath = join(packages, "node_modules", "@tian.zuo", "pi-devin-acp");
  await mkdir(join(packagePath, "dist"), { recursive: true });
  await mkdir(join(packages, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: dependency.source.identity, version: dependency.source.version }));
  await writeFile(join(packagePath, "dist", "custom.js"), "export default {};\n");
  await writeFile(join(packages, "node_modules", ".bin", "pi"), "#!/usr/bin/env node\n");
  return { dataHome, packageRoot, runtimeVersion: lock.harnessVersion, lock, environment,
    profiles, customPath: join(packagePath, "dist", "custom.js") };
}

it("uses locked declared non-default extension entrypoints through native Pi", async () => {
  const input = await fixture();
  const runtime = await createManagedPiRuntime(input);
  const profile = runtime.profiles.byId["implementer-research"]!;
  expect(profile.family).toBe("research-agent");
  expect(profile.extensions).toEqual([input.customPath]);
  expect(runtime.managedProfiles[profile.id]?.extensionPaths).toEqual([input.customPath]);
  const launch = buildPiLaunchSpec({ attemptId: "a", attemptToken: "t", piExecutable: runtime.piExecutable,
    piExecutableArgs: runtime.piExecutableArgs, profile, managed: runtime.managedProfiles[profile.id]!,
    transportExtensionPath: runtime.transportExtensionPath, cwd: input.packageRoot,
    sessionId: "s", sessionDir: join(input.dataHome, "sessions"), prompt: "test" });
  expect(launch.argv).toContain(input.customPath);
  expect(launch.argv).not.toContain(join(input.customPath, "..", "index.ts"));
});

it("recovers from frozen resolved profile without reading changed project declarations", async () => {
  const input = await fixture();
  const original = await createManagedPiRuntime(input);
  input.environment.pi_packages[0]!.resources.extensions = ["index.ts"];
  input.profiles.profiles["implementer-research"]!.model = "changed";
  const restarted = await createManagedPiRuntimeFromResolved({
    dataHome: input.dataHome, packageRoot: input.packageRoot,
    runtimeVersion: input.lock.harnessVersion, profiles: original.profiles,
  });
  expect(restarted.profiles.hash).toBe(original.profiles.hash);
  expect(restarted.profiles.byId["implementer-research"]?.extensions).toEqual([input.customPath]);
});
