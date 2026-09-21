import { canonicalJson } from "../shared/canonical-json.js";
import type {
  EffectivePolicy,
  SourceSelector,
  TrustedSource,
  TrustPolicy,
} from "./types.js";

function exact(left: TrustedSource, right: TrustedSource): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function authorized(expected: TrustedSource, actual: TrustedSource): boolean {
  if (exact(expected, actual)) return true;
  return (
    expected.kind === "npm" &&
    expected.integrity === "npm-registry:dist.integrity" &&
    actual.kind === expected.kind &&
    actual.identity === expected.identity &&
    actual.version === expected.version &&
    actual.registry === expected.registry &&
    /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(actual.integrity)
  );
}

function selected(source: TrustedSource, selector: SourceSelector): boolean {
  return source.kind === selector.kind && source.identity === selector.identity;
}

export function effectivePolicy(
  baseline: TrustPolicy,
  machine: TrustPolicy | undefined,
  project: TrustPolicy,
): EffectivePolicy {
  const baselineAllow = baseline.allow ?? [];
  return {
    allows(source) {
      if (!baselineAllow.some((candidate) => authorized(candidate, source))) return false;
      for (const policy of [baseline, machine, project]) {
        if (policy?.deny?.some((selector) => selected(source, selector))) return false;
        if (
          policy?.allow !== undefined &&
          policy.allow.length > 0 &&
          !policy.allow.some((candidate) => authorized(candidate, source))
        ) {
          return false;
        }
      }
      return true;
    },
  };
}
