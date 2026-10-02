import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readQuickWorkflowPreset,
  TrustedProjectReadError,
} from "../../src/cli/trusted-project-reader.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const PRESET = `schema: harness/v1
name: fixture-preset
stages:
  - id: quick_plan
    uses: harness.quick-plan
    with: { kind: bugfix }
`;

async function project(withPreset = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-preset-"));
  temporary.push(root);
  await mkdir(join(root, ".harness/workflows"), { recursive: true });
  if (withPreset) {
    await writeFile(join(root, ".harness/workflows/bugfix.yaml"), PRESET);
  }
  return root;
}

it("reads a valid quick workflow preset through the trusted reader", async () => {
  const root = await project();
  const preset = await readQuickWorkflowPreset(root, "bugfix");
  expect(preset.name).toBe("fixture-preset");
  expect(preset.stages[0]?.uses).toBe("harness.quick-plan");
});

it("reports a missing preset with a repair message", async () => {
  const root = await project(false);
  await expect(readQuickWorkflowPreset(root, "bugfix")).rejects.toThrow(
    /bugfix\.yaml.*(harness init|large-feature)/s,
  );
});

it("reports a missing workflows directory with a repair message", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-preset-"));
  temporary.push(root);
  await mkdir(join(root, ".harness"), { recursive: true });
  await expect(readQuickWorkflowPreset(root, "bugfix")).rejects.toThrow(
    /harness init|large-feature/,
  );
});

it("rejects a symlinked preset file", async () => {
  const root = await project(false);
  const outside = join(root, "outside.yaml");
  await writeFile(outside, PRESET);
  await symlink(outside, join(root, ".harness/workflows/bugfix.yaml"));
  await expect(readQuickWorkflowPreset(root, "bugfix")).rejects.toThrow(
    TrustedProjectReadError,
  );
});

it("rejects a symlinked workflows directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-preset-"));
  temporary.push(root);
  const elsewhere = join(root, "elsewhere");
  await mkdir(join(root, ".harness"), { recursive: true });
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "bugfix.yaml"), PRESET);
  await symlink(elsewhere, join(root, ".harness/workflows"));
  await expect(readQuickWorkflowPreset(root, "bugfix")).rejects.toThrow(
    TrustedProjectReadError,
  );
});

it("rejects an oversized preset file", async () => {
  const root = await project(false);
  await writeFile(
    join(root, ".harness/workflows/bugfix.yaml"),
    `# ${"x".repeat(1024 * 1024)}\n${PRESET}`,
  );
  await expect(readQuickWorkflowPreset(root, "bugfix")).rejects.toThrow(
    TrustedProjectReadError,
  );
});

it("rejects an invalid preset document", async () => {
  const root = await project(false);
  await writeFile(
    join(root, ".harness/workflows/bugfix.yaml"),
    "schema: harness/v1\nname: [not valid\n",
  );
  await expect(readQuickWorkflowPreset(root, "bugfix")).rejects.toThrow(
    /invalid|workflow/i,
  );
});
