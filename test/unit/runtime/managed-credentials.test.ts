import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ResolvedProfile } from "../../../src/config/profiles.js";
import { projectLocalSubscriptionCredentials } from "../../../src/runtime/managed/credentials.js";
import { managedRuntimePaths } from "../../../src/runtime/managed/paths.js";
import { sha256 } from "../../../src/shared/sha256.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function profile(family: "codex" | "devin" | "claude"): ResolvedProfile {
  return {
    id: `implementer-${family}`, family, runtime: "pi", provider: family,
    model: `${family}/model`, role: "implementation", environment: "isolated",
    tools: [], extensions: [], skills: [], promptTemplates: [], contextFiles: false, mcp: [],
    hash: sha256(family),
  };
}

it("projects only the selected provider subscription file and never overwrites managed login", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-credentials-"));
  roots.push(root);
  const home = join(root, "home");
  const source = join(home, ".local", "share", "devin", "credentials.toml");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "token = 'local-subscription'\n", { mode: 0o644 });
  await writeFile(join(home, "unrelated-secret"), "never-copy", "utf8");
  const paths = managedRuntimePaths({ dataHome: join(root, "managed"), runtimeVersion: "0.1.0", profileId: "implementer-devin" });
  const projected = await projectLocalSubscriptionCredentials({ profile: profile("devin"), paths, ambient: { HOME: home } });
  expect(projected).toEqual([join(paths.xdgDataHome, "devin", "credentials.toml")]);
  expect(await readFile(projected[0]!, "utf8")).toContain("local-subscription");
  expect((await lstat(projected[0]!)).mode & 0o777).toBe(0o600);
  await writeFile(projected[0]!, "token = 'managed-login'\n", "utf8");
  await projectLocalSubscriptionCredentials({ profile: profile("devin"), paths, ambient: { HOME: home } });
  expect(await readFile(projected[0]!, "utf8")).toContain("managed-login");
});

it("separates direct Pi auth from Codex CLI credential projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-credentials-"));
  roots.push(root);
  const home = join(root, "home");
  const piAuth = join(home, ".pi", "agent", "auth.json");
  const codexAuth = join(home, ".codex", "auth.json");
  await mkdir(dirname(piAuth), { recursive: true });
  await mkdir(dirname(codexAuth), { recursive: true });
  await writeFile(piAuth, "pi-secret");
  await writeFile(codexAuth, "codex-secret");
  const paths = managedRuntimePaths({ dataHome: join(root, "managed"), runtimeVersion: "0.1.0", profileId: "planner-codex" });
  const native = { ...profile("codex"), id: "planner-codex", provider: "openai-codex" };
  expect(await projectLocalSubscriptionCredentials({ profile: native, paths, ambient: { HOME: home } }))
    .toEqual([join(paths.piAgentDir, "auth.json")]);
  expect(await readFile(join(paths.piAgentDir, "auth.json"), "utf8")).toBe("pi-secret");
  const acp = { ...native, provider: "pi-shell-acp" };
  expect(await projectLocalSubscriptionCredentials({ profile: acp, paths, ambient: { HOME: home } }))
    .toEqual([join(paths.profileHome, ".codex", "auth.json")]);
  expect(await readFile(join(paths.profileHome, ".codex", "auth.json"), "utf8")).toBe("codex-secret");
});
