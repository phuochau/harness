import { describe, expect, it } from "vitest";
import { managedRuntimePaths } from "../../../src/runtime/managed/paths.js";

describe("managed runtime paths", () => {
  it("builds deterministic versioned profile roots", () => {
    expect(
      managedRuntimePaths({
        dataHome: "/var/lib/example",
        runtimeVersion: "0.1.0",
        profileId: "implementer-devin",
      }),
    ).toMatchObject({
      root: "/var/lib/example/pi-harness/runtimes/0.1.0",
      packages: "/var/lib/example/pi-harness/runtimes/0.1.0/packages",
      skills: "/var/lib/example/pi-harness/runtimes/0.1.0/skills",
      profileRoot:
        "/var/lib/example/pi-harness/runtimes/0.1.0/profiles/implementer-devin",
      profileHome:
        "/var/lib/example/pi-harness/runtimes/0.1.0/profiles/implementer-devin/home",
      piAgentDir:
        "/var/lib/example/pi-harness/runtimes/0.1.0/profiles/implementer-devin/pi-agent",
    });
  });

  it.each(["../escape", "a/b", "a\\b", "", ".", ".."])(
    "rejects unsafe runtime/profile ID %s",
    (value) => {
      expect(() =>
        managedRuntimePaths({
          dataHome: "/var/lib/example",
          runtimeVersion: value,
          profileId: "implementer-devin",
        }),
      ).toThrow(/safe identifier/);
      expect(() =>
        managedRuntimePaths({
          dataHome: "/var/lib/example",
          runtimeVersion: "0.1.0",
          profileId: value,
        }),
      ).toThrow(/safe identifier/);
    },
  );
});
