import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { initProject, InitError } from "../../src/cli/init.js";
import { main } from "../../src/cli/main.js";
import { mergeHarnessIgnore } from "../../src/cli/ignore-merge.js";
import { findPackageRoot } from "../../src/cli/package-root.js";
import {
  validateEnvironmentAndLock,
  validateProfiles,
  validateWorkflow,
} from "../../src/contracts/index.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(kind: "node" | "python", suffix = "project") {
  const parent = await mkdtemp(join(tmpdir(), "harness init "));
  temporary.push(parent);
  const root = join(parent, suffix);
  await cp(resolve(`test/fixtures/projects/${kind}`), root, { recursive: true });
  return root;
}

async function yaml(path: string) {
  return parse(await readFile(path, "utf8")) as Record<string, any>;
}

describe("harness init", () => {
  it("creates the full runnable default and all three worker preferences", async () => {
    const root = await fixture("node");
    await initProject({ root });
    const workflow = await yaml(join(root, ".harness/workflow.yaml"));
    expect(workflow.stages.map((stage: { id: string }) => stage.id)).toEqual([
      "specify",
      "plan",
      "approve_plan",
      "tasks",
      "implement",
      "review",
      "verify",
      "integrate",
      "post_integrate_verify",
      "record_task_done",
      "final_verify",
      "final_review",
      "push",
      "final_pr",
    ]);
    expect(workflow.stages.find((stage: { id: string }) => stage.id === "implement").runner.prefer).toEqual([
      "implementer-codex",
      "implementer-devin",
      "implementer-claude",
    ]);
    expect(workflow.stages.find((stage: { id: string }) => stage.id === "review").runner.prefer).toEqual([
      "reviewer-codex",
      "reviewer-devin",
      "reviewer-claude",
    ]);
    expect(() => validateWorkflow(workflow)).not.toThrow();
    const profiles = await yaml(join(root, ".harness/profiles.yaml"));
    expect(() => validateProfiles(profiles)).not.toThrow();
    expect(profiles.profiles["planner-codex"]).toMatchObject({
      provider: "openai-codex",
      role: "planning",
    });
    expect(profiles.profiles["implementer-devin"]).toMatchObject({
      provider: "devin",
      role: "implementation",
    });

    const environment = await yaml(join(root, ".harness/environment.yaml"));
    const lock = await yaml(join(root, ".harness/harness.lock"));
    expect(environment.commands).toEqual({
      task_verify: ["npm", "test"],
      full_verify: ["npm", "run", "verify"],
    });
    expect(environment.pi_packages).toEqual([
      {
        id: "harness",
        dependency: "pi-multi-agent-harness",
        scope: "project",
        resources: { extensions: ["dist/pi/extension.js"] },
      },
      {
        id: "devin-acp",
        dependency: "pi-devin-acp",
        scope: "managed",
        resources: { extensions: ["index.ts"] },
      },
      {
        id: "claude-bridge",
        dependency: "pi-claude-bridge",
        scope: "managed",
        resources: { extensions: ["src/index.ts"] },
      },
    ]);
    expect(environment.agent_plugins).toBeUndefined();
    expect(() => validateEnvironmentAndLock(environment, lock)).not.toThrow();

    const settings = JSON.parse(await readFile(join(root, ".pi/settings.json"), "utf8"));
    expect(settings.packages).toContainEqual({
      source: "npm:pi-multi-agent-harness@0.1.0",
      extensions: ["+dist/pi/extension.js"],
      skills: [],
      prompts: [],
      themes: [],
    });
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain("custom-output/");
    expect(ignore).toContain(".pi/npm/");
    expect(ignore).toContain(".pi/git/");
    expect(ignore).toContain(".harness-output/");
    expect(ignore).not.toContain(".pi/settings.json");
  });

  it("detects pytest commands without executing project code", async () => {
    const root = await fixture("python");
    await initProject({ root });
    const environment = await yaml(join(root, ".harness/environment.yaml"));
    expect(environment.commands).toEqual({
      task_verify: ["python", "-m", "pytest"],
      full_verify: ["python", "-m", "pytest"],
    });
  });

  it("supports paths with spaces and projects that are not Git repositories", async () => {
    const root = await fixture("node", "project with spaces");
    await initProject({ root });
    expect(await readFile(join(root, ".harness/workflow.yaml"), "utf8")).toContain(
      "spec-kit-multi-agent",
    );
  });

  it("refuses to overwrite customized configuration", async () => {
    const root = await fixture("node");
    await mkdir(join(root, ".harness"));
    await writeFile(join(root, ".harness/workflow.yaml"), "name: custom\n", "utf8");
    await expect(initProject({ root })).rejects.toThrow(/already exists/);
    expect(await readFile(join(root, ".harness/workflow.yaml"), "utf8")).toBe(
      "name: custom\n",
    );
  });

  it("fails ambiguous detection with exact noninteractive flags", async () => {
    const root = await fixture("node");
    await writeFile(
      join(root, "pyproject.toml"),
      "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
      "utf8",
    );
    await expect(initProject({ root })).rejects.toThrow(
      /--task-verify.*--full-verify/,
    );
    await expect(
      initProject({
        root,
        commands: {
          taskVerify: ["npm", "test"],
          fullVerify: ["npm", "run", "verify"],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the managed ignore block bounded and idempotent", () => {
    const once = mergeHarnessIgnore("dist/\n");
    const twice = mergeHarnessIgnore(once);
    expect(twice).toBe(once);
    expect(once.match(/# BEGIN pi-multi-agent-harness/g)).toHaveLength(1);
    expect(once).toContain("dist/\n");
  });

  it("finds packaged defaults from the module location rather than cwd", async () => {
    const packageRoot = await findPackageRoot(import.meta.url, "pi-multi-agent-harness");
    expect(basename(packageRoot)).toBe("harness");
    expect(await readFile(join(packageRoot, "src/defaults/workflow.yaml"), "utf8")).toContain(
      "schema: harness/v1",
    );
  });

  it("reports empty detection as an init error", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-empty-"));
    temporary.push(root);
    await expect(initProject({ root })).rejects.toBeInstanceOf(InitError);
  });

  it("accepts explicit JSON argv commands through the public CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-cli-"));
    temporary.push(root);
    await expect(
      main([
        "init",
        root,
        "--task-verify",
        '["node","test-task.mjs"]',
        "--full-verify",
        '["node","test-all.mjs"]',
      ]),
    ).resolves.toBe(0);
    const environment = await yaml(join(root, ".harness/environment.yaml"));
    expect(environment.commands).toEqual({
      task_verify: ["node", "test-task.mjs"],
      full_verify: ["node", "test-all.mjs"],
    });
  });
});
