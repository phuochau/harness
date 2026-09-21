import { expect, it } from "vitest";
import { builtInBaseline } from "../../../src/install/baseline-policy.js";
import { effectivePolicy } from "../../../src/install/policy.js";
import type { TrustedSource, TrustPolicy } from "../../../src/install/types.js";

const harness: TrustedSource = {
  kind: "npm",
  identity: "pi-multi-agent-harness",
  version: "0.1.0",
  integrity: "package-release:pi-multi-agent-harness@0.1.0",
};

it("allows exact release-manifest sources without an external machine policy", () => {
  const policy = effectivePolicy(builtInBaseline(), undefined, {});
  expect(policy.allows(harness)).toBe(true);
  expect(
    policy.allows({
      kind: "npm",
      identity: "unknown",
      version: "1.0.0",
      integrity: "sha512-x",
    }),
  ).toBe(false);
});

it("lets machine and project policy narrow but never broaden the baseline", () => {
  const denyHarness: TrustPolicy = {
    deny: [{ kind: "npm", identity: "pi-multi-agent-harness" }],
  };
  const broaden: TrustPolicy = {
    allow: [
      {
        kind: "npm",
        identity: "unknown",
        version: "1.0.0",
        integrity: "sha512-x",
      },
    ],
  };
  expect(effectivePolicy(builtInBaseline(), denyHarness, {}).allows(harness)).toBe(false);
  expect(
    effectivePolicy(builtInBaseline(), undefined, broaden).allows(broaden.allow![0]!),
  ).toBe(false);
});

it("requires every trusted-source field to match exactly", () => {
  expect(
    effectivePolicy(builtInBaseline(), undefined, {}).allows({
      ...harness,
      version: "0.1.1",
    }),
  ).toBe(false);
});
