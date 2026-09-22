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
        integrity: "npm-registry:dist.integrity",
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
    environment: {
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      npm_config_registry: "https://registry.npmjs.org/",
    },
    expectedMutations: [".pi/settings.json", ".pi/npm/**"],
  });
  expect(plan.warnings.join(" ")).toMatch(/arbitrary code/);
});

it("installs managed Pi provider packages under the approved runtime root", () => {
  const providerLock: HarnessLock = {
    ...piLock,
    dependencies: [
      {
        ...piLock.dependencies[0]!,
        id: "pi-devin-acp",
        version: "0.3.4",
        source: {
          kind: "npm",
          identity: "@tian.zuo/pi-devin-acp",
          version: "0.3.4",
          integrity: "sha512-su1j4yDc8nSvHvx4eFvyXp2BAHFjArThdKUzEoy+v/AnLUKx6E39bFXzS0RZGTweueddKKdhiihEeK5yWaH1nQ==",
        },
        piSource: "npm:@tian.zuo/pi-devin-acp@0.3.4",
      },
    ],
  };
  const plan = createInstallPlan(
    providerLock,
    { byId: { "pi-devin-acp": { id: "pi-devin-acp", status: "missing" } } },
    effectivePolicy(builtInBaseline(), undefined, {}),
    {
      managedDependencyIds: new Set(["pi-devin-acp"]),
      managedRoot: "/managed/pi-harness/runtimes/0.1.0/packages",
    },
  );
  expect(plan.steps[0]).toMatchObject({
    mode: "automatic",
    executable: "npm",
    scope: "managed",
    argv: [
      "install",
      "--prefix",
      "/managed/pi-harness/runtimes/0.1.0/packages",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org/",
      "@tian.zuo/pi-devin-acp@0.3.4",
    ],
  });
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

it("accepts versions satisfying a locked minimum and system capability", () => {
  const lock: HarnessLock = {
    ...piLock,
    dependencies: [
      { ...piLock.dependencies[0]!, id: "node", version: ">=22.22.2" },
      { ...piLock.dependencies[0]!, id: "git", version: "system" },
    ],
  };
  const plan = createInstallPlan(
    lock,
    {
      byId: {
        node: { id: "node", status: "present", version: "22.23.0" },
        git: { id: "git", status: "present", version: "2.51.0" },
      },
    },
    effectivePolicy(builtInBaseline(), undefined, {}),
  );
  expect(plan.steps.map((step) => step.mode)).toEqual(["skipped", "skipped"]);
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

it("keeps a project-declared but release-unlisted npm source as a blocking manual step", () => {
  const unknown: HarnessLock = {
    ...piLock,
    dependencies: [{
      id: "unknown-pi-bridge", kind: "pi-package", version: "1.2.3",
      source: { kind: "npm", identity: "@example/bridge", version: "1.2.3", integrity: "sha512-test" },
      piSource: "npm:@example/bridge@1.2.3", dependsOn: [],
    }],
  };
  expect(createInstallPlan(
    unknown,
    { byId: { "unknown-pi-bridge": { id: "unknown-pi-bridge", status: "missing" } } },
    effectivePolicy(builtInBaseline(), undefined, {}),
  ).steps[0]).toMatchObject({ mode: "manual", blocking: true });
});
