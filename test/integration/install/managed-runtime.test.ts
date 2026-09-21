import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../../../src/config/profiles.js";
import { materializeProfile } from "../../../src/runtime/managed/materialize.js";
import { managedRuntimePaths } from "../../../src/runtime/managed/paths.js";
import { sha256 } from "../../../src/shared/sha256.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(family: "devin" | "claude") {
  const root = await mkdtemp(join(tmpdir(), "managed-runtime-"));
  temporary.push(root);
  const userEstate = join(root, "user-home");
  const source = join(root, "locked-source");
  await mkdir(join(userEstate, ".agents/skills/global"), { recursive: true });
  await writeFile(join(userEstate, ".agents/skills/global/SKILL.md"), "GLOBAL", "utf8");
  await mkdir(join(source, "skill/references"), { recursive: true });
  await writeFile(join(source, "skill/SKILL.md"), "# Selected skill", "utf8");
  await writeFile(join(source, "skill/references/note.md"), "supporting", "utf8");
  await writeFile(join(source, "extension.mjs"), "export default {}", "utf8");
  await writeFile(join(source, "prompt.md"), "Use Spec Kit", "utf8");
  const profileId = `implementer-${family}`;
  const profile: ResolvedProfile = {
    id: profileId,
    family,
    runtime: "pi",
    provider: family === "devin" ? "devin" : "claude-bridge",
    model: family === "devin" ? "devin/swe-2" : "claude-bridge/claude-sonnet-5",
    role: "implementation",
    environment: "isolated",
    tools: ["read", "bash"],
    extensions: [join(source, "extension.mjs")],
    skills: [
      {
        id: "superpowers:test-driven-development",
        path: join(source, "skill/SKILL.md"),
        targets: ["pi", "provider"],
      },
    ],
    promptTemplates: [join(source, "prompt.md")],
    contextFiles: false,
    mcp: [],
    hash: sha256(profileId),
  };
  return {
    root,
    userEstate,
    profile,
    paths: managedRuntimePaths({
      dataHome: join(root, "managed-data"),
      runtimeVersion: "0.1.0",
      profileId,
    }),
  };
}

async function userEstateSnapshot(root: string): Promise<string> {
  return readFile(join(root, ".agents/skills/global/SKILL.md"), "utf8");
}

describe("managed profile materialization", () => {
  it("copies only selected Devin resources and leaves global state untouched", async () => {
    const input = await fixture("devin");
    const before = await userEstateSnapshot(input.userEstate);
    const view = await materializeProfile(input.profile, input.paths, {
      ambient: { HOME: input.userEstate, SECRET_TOKEN: "do-not-copy" },
      forwardedKeys: [],
      executablePath: "/usr/bin:/bin",
    });

    expect(await userEstateSnapshot(input.userEstate)).toBe(before);
    expect(view.extensionPaths[0]).toMatch(`${input.paths.profileRoot}/resources/extensions/`);
    expect(view.piSkillPaths[0]).toMatch(`${input.paths.profileRoot}/resources/skills/`);
    expect(view.providerSkillPaths[0]).toMatch(
      `${input.paths.profileHome}/.agents/skills/`,
    );
    expect(await readFile(view.providerSkillPaths[0]!, "utf8")).toBe(
      "# Selected skill",
    );
    expect(await readFile(join(dirname(view.providerSkillPaths[0]!), "references/note.md"), "utf8"))
      .toBe("supporting");
    expect((await lstat(dirname(view.providerSkillPaths[0]!))).isSymbolicLink()).toBe(false);
    expect(view.environment.HOME).toBe(input.paths.profileHome);
    expect(view.environment.SECRET_TOKEN).toBeUndefined();
    expect(view.receiptHash).toMatch(/^sha256:/);
  });

  it("writes a closed Claude bridge configuration", async () => {
    const input = await fixture("claude");
    const view = await materializeProfile(input.profile, input.paths);
    const configuration = JSON.parse(
      await readFile(join(input.paths.piAgentDir, "claude-bridge.json"), "utf8"),
    );
    expect(configuration).toMatchObject({
      strictMcpConfig: true,
      askClaude: { enabled: false },
      autoMemoryEnabled: false,
      mcpServers: {},
    });
    expect(configuration.forwardedSkills).toEqual([
      { id: "superpowers:test-driven-development", content: "# Selected skill" },
    ]);
    expect(view.providerSkillPaths).toEqual(view.piSkillPaths);
  });

  it("preserves only allowlisted subscription credentials across rematerialization", async () => {
    const input = await fixture("devin");
    await materializeProfile(input.profile, input.paths);
    const credential = join(input.paths.xdgConfigHome, "devin", "config.json");
    await mkdir(dirname(credential), { recursive: true });
    await writeFile(credential, '{"subscription":"ready"}\n', { mode: 0o600 });
    await writeFile(join(input.paths.profileHome, "ambient-secret"), "do-not-preserve", "utf8");
    await materializeProfile(input.profile, input.paths);
    await expect(readFile(credential, "utf8")).resolves.toContain("subscription");
    await expect(readFile(join(input.paths.profileHome, "ambient-secret"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed until declared MCP projection is implemented", async () => {
    const input = await fixture("claude");
    await expect(
      materializeProfile({ ...input.profile, mcp: ["/managed/mcp/github.json"] }, input.paths),
    ).rejects.toThrow(/MCP projection/);
  });
});
