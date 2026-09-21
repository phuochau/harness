import { releaseManifest } from "./release-manifest.js";
import type { TrustPolicy } from "./types.js";

export function builtInBaseline(): TrustPolicy {
  return { allow: releaseManifest.map((entry) => entry.source) };
}
