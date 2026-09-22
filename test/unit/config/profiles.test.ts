import { describe, expect, it } from "vitest";
import type { ProfileDocument } from "../../../src/contracts/profiles.js";
import {
  resolveProfiles,
  type LockedProfileResources,
} from "../../../src/config/profiles.js";

const resources: LockedProfileResources = {
  extensions: {
    "devin-acp": "/managed/extensions/devin-acp/index.js",
  },
  skills: {
    "superpowers:test-driven-development":
      "/managed/skills/test-driven-development/SKILL.md",
  },
  promptTemplates: {
    "spec-kit": "/managed/prompts/spec-kit.md",
  },
  mcp: {
    github: "/managed/mcp/github.json",
  },
};

function profileDocument(): ProfileDocument {
  return {
    schema: "harness/profiles/v1",
    profiles: {
      "planner-codex": {
        family: "codex",
        runtime: "pi",
        provider: "openai-codex",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "high",
        role: "planning",
        environment: "isolated",
        tools: ["write", "read"],
        extensions: [],
        skills: [],
        context_files: false,
        prompt_templates: ["spec-kit"],
        mcp: [],
      },
      "implementer-devin": {
        family: "devin",
        runtime: "pi",
        provider: "devin",
        model: "devin/swe-2",
        role: "implementation",
        environment: "isolated",
        tools: ["read", "bash"],
        extensions: ["devin-acp"],
        skills: [
          {
            id: "superpowers:test-driven-development",
            targets: ["provider", "pi"],
          },
        ],
        context_files: false,
        prompt_templates: [],
        mcp: ["github"],
      },
    },
  };
}

describe("profile resolution", () => {
  it("freezes canonical hashes and exact locked resource paths", () => {
    const resolved = resolveProfiles(profileDocument(), resources);

    expect(resolved.byId["implementer-devin"]).toMatchObject({
      id: "implementer-devin",
      family: "devin",
      provider: "devin",
      role: "implementation",
      extensions: ["/managed/extensions/devin-acp/index.js"],
      promptTemplates: [],
      mcp: ["/managed/mcp/github.json"],
    });
    expect(resolved.byId["implementer-devin"]?.skills).toEqual([
      {
        id: "superpowers:test-driven-development",
        path: "/managed/skills/test-driven-development/SKILL.md",
        targets: ["pi", "provider"],
      },
    ]);
    expect(resolved.byId["implementer-devin"]?.tools).toEqual(["bash", "read"]);
    expect(resolved.byId["implementer-devin"]?.hash).toMatch(/^sha256:/);
    expect(resolved.hash).toMatch(/^sha256:/);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.byId["implementer-devin"])).toBe(true);
  });

  it("rejects missing locked resources", () => {
    expect(() =>
      resolveProfiles(profileDocument(), { ...resources, extensions: {} }),
    ).toThrow(/devin-acp.*locked extension/);
  });

  it("rejects provider skill projection for unsupported families", () => {
    const document = profileDocument();
    document.profiles["planner-codex"]!.skills = [
      {
        id: "superpowers:test-driven-development",
        targets: ["provider"],
      },
    ];
    expect(() => resolveProfiles(document, resources)).toThrow(
      /provider skill projection.*codex/,
    );
  });

  it("produces the same hash for reordered set-like fields", () => {
    const first = resolveProfiles(profileDocument(), resources);
    const reordered = profileDocument();
    reordered.profiles["implementer-devin"]!.tools = ["read", "bash"];
    reordered.profiles["implementer-devin"]!.skills[0]!.targets = [
      "pi",
      "provider",
    ];
    expect(resolveProfiles(reordered, resources).hash).toBe(first.hash);
  });

  it("keeps legacy v1 identities while accepting an explicit integration and open family", () => {
    const before = resolveProfiles(profileDocument(), resources);
    expect(before.byId["implementer-devin"]?.hash).toBe(
      "sha256:89710cd4924fcb2ac5e753e6466cc0bb6643632c66212c94b367707b32a519fa",
    );
    expect(before.hash).toBe(
      "sha256:7082d81d59280c11387bee8a5ef8283df444e138cb4e2dfda6bdf6bfe3418b01",
    );
    expect(before.byId["implementer-devin"]).not.toHaveProperty("integration");

    const custom = profileDocument();
    custom.profiles["implementer-devin"]!.family = "research-agent";
    custom.profiles["implementer-devin"]!.integration = "devin-cli";
    expect(resolveProfiles(custom, resources).byId["implementer-devin"]).toMatchObject({
      family: "research-agent",
      integration: "devin-cli",
    });
    expect(resolveProfiles(profileDocument(), resources).hash).toBe(before.hash);

    custom.profiles["implementer-devin"]!.integration = "unknown-cli";
    expect(() => resolveProfiles(custom, resources)).toThrow(/implementer-devin.*unknown-cli/);
  });

  it("rejects an explicit native Pi integration for a bridge provider", () => {
    const document = profileDocument();
    document.profiles["implementer-devin"]!.integration = "pi-native";
    expect(() => resolveProfiles(document, resources)).toThrow(/implementer-devin.*pi-native.*devin/);
    expect(resolveProfiles(profileDocument(), resources).byId["planner-codex"])
      .not.toHaveProperty("integration");
  });

  it("flattens multi-entrypoint extension resources without changing legacy strings", () => {
    const multiple = resolveProfiles(profileDocument(), {
      ...resources,
      extensions: { "devin-acp": ["/managed/b.js", "/managed/a.js"] },
    });
    expect(multiple.byId["implementer-devin"]?.extensions).toEqual(["/managed/b.js", "/managed/a.js"]);
    expect(resolveProfiles(profileDocument(), resources).byId["implementer-devin"]?.extensions)
      .toEqual(["/managed/extensions/devin-acp/index.js"]);
  });
});
