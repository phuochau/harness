import { describe, expect, it } from "vitest";
import { createAssignment } from "../../../src/core/assignment.js";
import {
  PolicyBlocker,
  selectInitialComplexityRoute,
  selectNextFixRoute,
  selectProfile,
  type RouteCandidate,
} from "../../../src/core/routing.js";
import type { ComplexityRunner } from "../../../src/contracts/workflow.js";
import type { ProfileCapabilitySnapshot } from "../../../src/state/resolved-run-config.js";
import { assignmentFixture } from "../../support/controller-fixtures.js";

const candidates: Readonly<Record<string, RouteCandidate>> = {
  "implementer-codex": {
    profileId: "implementer-codex",
    family: "codex",
    available: true,
  },
  "implementer-devin": {
    profileId: "implementer-devin",
    family: "devin",
    available: false,
  },
  "reviewer-codex": {
    profileId: "reviewer-codex",
    family: "codex",
    available: true,
  },
  "reviewer-claude": {
    profileId: "reviewer-claude",
    family: "claude",
    available: true,
  },
};

describe("profile routing", () => {
  it("falls back in declared profile order", () => {
    expect(
      selectProfile(
        ["implementer-devin", "implementer-codex"],
        candidates,
      ).profileId,
    ).toBe("implementer-codex");
  });

  it("does not cross the excluded implementation family for review", () => {
    expect(
      selectProfile(
        ["reviewer-codex", "reviewer-claude"],
        candidates,
        "codex",
      ).profileId,
    ).toBe("reviewer-claude");
  });

  it("can route a new independent family without scheduler changes", () => {
    expect(selectProfile(
      ["reviewer-codex", "reviewer-research"],
      { ...candidates, "reviewer-research": {
        profileId: "reviewer-research", family: "research-agent", available: true,
      } },
      "codex",
    ).profileId).toBe("reviewer-research");
  });

  it("blocks when no eligible profile exists", () => {
    expect(() =>
      selectProfile(["implementer-devin"], candidates),
    ).toThrowError(PolicyBlocker);
  });

  it("binds assignments to both profile ID and family", () => {
    const assignment = createAssignment(
      assignmentFixture({
        profileId: "implementer-devin",
        profileFamily: "devin",
      }),
    );
    expect(assignment).toMatchObject({
      profileId: "implementer-devin",
      profileFamily: "devin",
      workerKind: "devin",
    });
    expect(Object.isFrozen(assignment)).toBe(true);
  });

  it("rejects transitional worker identity drift", () => {
    expect(() =>
      createAssignment(
        assignmentFixture({
          profileId: "implementer-devin",
          profileFamily: "devin",
          workerKind: "codex",
        }),
      ),
    ).toThrow(/profile family.*worker kind/);
  });
});

const complexityRunner: ComplexityRunner = {
  by_complexity: {
    mechanical: ["implementer-fast"],
    standard: ["implementer-standard-a", "implementer-standard-b"],
    complex: ["implementer-strong"],
  },
};

function capabilitySnapshot(
  availability: Readonly<Record<string, boolean>>,
): ProfileCapabilitySnapshot {
  return Object.fromEntries(
    Object.entries(availability).map(([profileId, available]) => [
      profileId,
      {
        available,
        evidence: [
          available
            ? "managed profile resources verified"
            : "managed resource is missing",
        ],
      },
    ]),
  );
}

describe("initial complexity route", () => {
  it("selects the first available declared profile in the task's tier", () => {
    const route = selectInitialComplexityRoute({
      complexity: "standard",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-fast": true,
        "implementer-standard-a": false,
        "implementer-standard-b": true,
        "implementer-strong": true,
      }),
    });
    expect(route).toEqual({
      profileId: "implementer-standard-b",
      actualTier: "standard",
      candidates: [
        "implementer-standard-a",
        "implementer-standard-b",
        "implementer-strong",
      ],
    });
  });

  it("falls back only upward when no same-tier candidate is available", () => {
    const route = selectInitialComplexityRoute({
      complexity: "mechanical",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-standard-a": false,
        "implementer-standard-b": false,
        "implementer-strong": true,
      }),
    });
    expect(route).toEqual({
      profileId: "implementer-strong",
      actualTier: "complex",
      candidates: [
        "implementer-fast",
        "implementer-standard-a",
        "implementer-standard-b",
        "implementer-strong",
      ],
    });
  });

  it("never downgrades a complex task to a weaker tier", () => {
    const route = selectInitialComplexityRoute({
      complexity: "complex",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-fast": true,
        "implementer-standard-a": true,
        "implementer-strong": false,
      }),
    });
    expect(route).toEqual({ blockReason: "no_available_profile" });
  });

  it("never downgrades a standard task to the mechanical tier", () => {
    const route = selectInitialComplexityRoute({
      complexity: "standard",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-fast": true,
        "implementer-standard-a": false,
        "implementer-standard-b": false,
        "implementer-strong": false,
      }),
    });
    expect(route).toEqual({ blockReason: "no_available_profile" });
  });

  it("blocks when no declared candidate is available", () => {
    const route = selectInitialComplexityRoute({
      complexity: "mechanical",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-fast": false,
        "implementer-standard-a": false,
        "implementer-standard-b": false,
        "implementer-strong": false,
      }),
    });
    expect(route).toEqual({ blockReason: "no_available_profile" });
  });

  it("treats profiles missing from the snapshot as unavailable", () => {
    const route = selectInitialComplexityRoute({
      complexity: "mechanical",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-standard-a": true,
      }),
    });
    expect(route).toMatchObject({
      profileId: "implementer-standard-a",
      actualTier: "standard",
    });
  });
});

describe("next fix route", () => {
  it("resumes the original profile and transcript for fix rounds 1 through 3", () => {
    for (const fixRound of [0, 1, 2] as const) {
      const route = selectNextFixRoute({
        fixRound,
        originalProfileId: "implementer-standard-a",
        originalTier: "standard",
        runner: complexityRunner,
        capabilities: capabilitySnapshot({}),
      });
      expect(route).toEqual({
        profileId: "implementer-standard-a",
        tier: "standard",
        nextFixRound: fixRound + 1,
        cause: "review_fix",
        freshTranscript: false,
        candidates: ["implementer-standard-a"],
      });
    }
  });

  it("escalates to the nearest stronger declared tier at fix round 4", () => {
    const route = selectNextFixRoute({
      fixRound: 3,
      originalProfileId: "implementer-fast",
      originalTier: "mechanical",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-standard-a": false,
        "implementer-standard-b": true,
        "implementer-strong": true,
      }),
    });
    expect(route).toEqual({
      profileId: "implementer-standard-b",
      tier: "standard",
      nextFixRound: 4,
      cause: "escalation",
      freshTranscript: true,
      candidates: [
        "implementer-standard-a",
        "implementer-standard-b",
        "implementer-strong",
      ],
    });
  });

  it("escalates again for fix round 5", () => {
    const route = selectNextFixRoute({
      fixRound: 4,
      originalProfileId: "implementer-standard-a",
      originalTier: "standard",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({ "implementer-strong": true }),
    });
    expect(route).toEqual({
      profileId: "implementer-strong",
      tier: "complex",
      nextFixRound: 5,
      cause: "escalation",
      freshTranscript: true,
      candidates: ["implementer-strong"],
    });
  });

  it("never treats a same-tier or weaker profile as an escalation", () => {
    const route = selectNextFixRoute({
      fixRound: 3,
      originalProfileId: "implementer-standard-a",
      originalTier: "standard",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-fast": true,
        "implementer-standard-b": true,
        "implementer-strong": false,
      }),
    });
    expect(route).toEqual({ blockReason: "no_escalation_profile" });
  });

  it("blocks with no_escalation_profile at the strongest declared tier", () => {
    const route = selectNextFixRoute({
      fixRound: 3,
      originalProfileId: "implementer-strong",
      originalTier: "complex",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({
        "implementer-fast": true,
        "implementer-standard-a": true,
        "implementer-strong": true,
      }),
    });
    expect(route).toEqual({ blockReason: "no_escalation_profile" });
  });

  it("blocks with no_escalation_profile when no stronger-tier profile is available", () => {
    const route = selectNextFixRoute({
      fixRound: 3,
      originalProfileId: "implementer-standard-a",
      originalTier: "standard",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({ "implementer-strong": false }),
    });
    expect(route).toEqual({ blockReason: "no_escalation_profile" });
  });

  it("stops automatic fixes after a reviewed round 5", () => {
    const route = selectNextFixRoute({
      fixRound: 5,
      originalProfileId: "implementer-standard-a",
      originalTier: "standard",
      runner: complexityRunner,
      capabilities: capabilitySnapshot({ "implementer-strong": true }),
    });
    expect(route).toEqual({ blockReason: "fix_rounds_exhausted" });
  });
});
