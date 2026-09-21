import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function loadExtension(path: string) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-loader-"));
  temporary.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [resolve(path)],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return { cwd, loader, result: loader.getExtensions() };
}

it("loads the source extension through Pi's real resource loader", async () => {
  const { result } = await loadExtension("src/pi/extension.ts");
  expect(result.errors).toEqual([]);
  expect(result.extensions).toHaveLength(1);
  const extension = result.extensions[0]!;
  expect([...extension.commands.keys()].filter((name) => name.startsWith("harness-"))).toEqual([
    "harness-run",
    "harness-status",
    "harness-graph",
    "harness-task",
    "harness-logs",
    "harness-retry",
    "harness-reroute",
    "harness-cancel",
    "harness-pause",
    "harness-resume",
    "harness-doctor",
  ]);
  expect(extension.handlers.get("session_start")).toHaveLength(1);
  expect(extension.handlers.get("session_shutdown")).toHaveLength(1);
});

it("starts and disposes a real idle Pi session without launching a model turn", async () => {
  const { cwd, loader } = await loadExtension("src/pi/extension.ts");
  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  session.dispose();
});

it.runIf(process.env.HARNESS_COMPAT_PI === "1")(
  "loads the built extension with the pinned installed Pi",
  async () => {
    const { result } = await loadExtension("dist/pi/extension.js");
    expect(result.errors).toEqual([]);
    expect(result.extensions.length).toBeGreaterThan(0);
  },
);
