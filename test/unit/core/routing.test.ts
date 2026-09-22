import { describe, expect, it } from "vitest";
import { createAssignment } from "../../../src/core/assignment.js";
import {
  PolicyBlocker,
  selectProfile,
  type RouteCandidate,
} from "../../../src/core/routing.js";
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
