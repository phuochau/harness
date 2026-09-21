import { expect, it } from "vitest";
import type { HarnessLock } from "../../../src/contracts/lock.js";
import { builtInBaseline } from "../../../src/install/baseline-policy.js";
import { createInstallPlan } from "../../../src/install/plan.js";
import { effectivePolicy } from "../../../src/install/policy.js";

const piLock: HarnessLock = {
  schema: "harness/lock/v1",
  harnessVersion: "0.1.0",
  dependencies: [
    {
      id: "pi-multi-agent-harness",
      kind: "pi-package",
      version: "0.1.0",
      source: {
        kind: "npm",
        identity: "pi-multi-agent-harness",
        version: "0.1.0",
        integrity: "package-release:pi-multi-agent-harness@0.1.0",
      },
      piSource: "npm:pi-multi-agent-harness@0.1.0",
      dependsOn: [],
    },
  ],
};

it("uses the exact locked project-local Pi package recipe", () => {
  const plan = createInstallPlan(
    piLock,
    { byId: { "pi-multi-agent-harness": { id: "pi-multi-agent-harness", status: "missing" } } },
    effectivePolicy(builtInBaseline(), undefined, {}),
  );
  expect(plan.steps[0]).toMatchObject({
    mode: "automatic",
    executable: "pi",
    argv: ["install", "-l", "npm:pi-multi-agent-harness@0.1.0"],
    expectedMutations: [".pi/settings.json", ".pi/npm/**"],
  });
  expect(plan.warnings.join(" ")).toMatch(/arbitrary code/);
});

it("marks unknown or unverifiable sources as manual blockers", () => {
  const lock: HarnessLock = {
    ...piLock,
    dependencies: [
      {
        id: "unknown",
        kind: "tool",
        version: "main",
        source: {
          kind: "git",
          identity: "https://example.invalid/unknown.git",
          version: "main",
          integrity: "none",
        },
        dependsOn: [],
      },
    ],
  };
  const plan = createInstallPlan(
    lock,
    { byId: { unknown: { id: "unknown", status: "unverifiable" } } },
    effectivePolicy(builtInBaseline(), undefined, {}),
  );
  expect(plan.steps[0]).toMatchObject({ mode: "manual", blocking: true });
});

it("orders dependencies and skips exact versions already present", () => {
  const lock: HarnessLock = {
    ...piLock,
    dependencies: [
      { ...piLock.dependencies[0]!, id: "child", dependsOn: ["parent"] },
      { ...piLock.dependencies[0]!, id: "parent", dependsOn: [] },
    ],
  };
  const plan = createInstallPlan(
    lock,
    {
      byId: {
        parent: { id: "parent", status: "present", version: "0.1.0" },
        child: { id: "child", status: "missing" },
      },
    },
    effectivePolicy(builtInBaseline(), undefined, {}),
  );
  expect(plan.steps.map((step) => [step.id, step.mode])).toEqual([
    ["parent", "skipped"],
    ["child", "automatic"],
  ]);
});

it("blocks unsafe observed state and unexpected project package entries", () => {
  const plan = createInstallPlan(
    piLock,
    {
      byId: {
        "pi-multi-agent-harness": {
          id: "pi-multi-agent-harness",
          status: "wrong_source",
        },
        "pi-package:unexpected:opaque": {
          id: "pi-package:unexpected:opaque",
          status: "unexpected",
        },
      },
    },
    effectivePolicy(builtInBaseline(), undefined, {}),
  );
  expect(plan.steps.every((step) => step.mode === "manual" && step.blocking)).toBe(true);
});

it("requires explicit repair before replacing disabled Pi resource filters", () => {
  const report = {
    byId: {
      "pi-multi-agent-harness": {
        id: "pi-multi-agent-harness",
        status: "disabled" as const,
      },
    },
  };
  const policy = effectivePolicy(builtInBaseline(), undefined, {});
  expect(createInstallPlan(piLock, report, policy).steps[0]?.mode).toBe("manual");
  expect(createInstallPlan(piLock, report, policy, { repair: true }).steps[0]?.mode)
    .toBe("automatic");
});
