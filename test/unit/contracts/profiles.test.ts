import { describe, expect, it } from "vitest";
import { validateProfiles } from "../../../src/contracts/profiles.js";

function validProfile() {
  return {
    family: "devin",
    runtime: "pi",
    provider: "devin",
    model: "devin/swe-2",
    role: "implementation",
    environment: "isolated",
    tools: ["read"],
    extensions: [],
    skills: [
      {
        id: "superpowers:test-driven-development",
        targets: ["pi", "provider"],
      },
    ],
    context_files: false,
    prompt_templates: [],
    mcp: [],
  } as const;
}

describe("profile contract", () => {
  it("rejects unsupported skill targets", () => {
    expect(() =>
      validateProfiles({
        schema: "harness/profiles/v1",
        profiles: {
          bad: {
            ...validProfile(),
            skills: [
              {
                id: "superpowers:test-driven-development",
                targets: ["unknown"],
              },
            ],
          },
        },
      }),
    ).toThrow(/targets/);
  });

  it("rejects undeclared profile fields", () => {
    expect(() =>
      validateProfiles({
        schema: "harness/profiles/v1",
        profiles: {
          bad: { ...validProfile(), implicit_global_discovery: true },
        },
      }),
    ).toThrow(/additional properties/);
  });

  it("accepts symbolic MCP resource IDs while defaults remain empty", () => {
    expect(
      validateProfiles({
        schema: "harness/profiles/v1",
        profiles: {
          implementation: { ...validProfile(), mcp: ["github"] },
        },
      }).profiles.implementation?.mcp,
    ).toEqual(["github"]);
  });
});
