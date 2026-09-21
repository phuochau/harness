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
});
