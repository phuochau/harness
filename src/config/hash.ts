import { canonicalJson } from "../shared/canonical-json.js";
import { sha256 } from "../shared/sha256.js";

export function contentRevision(value: unknown): `sha256:${string}` {
  return sha256(canonicalJson(value));
}
