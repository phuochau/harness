import { canonicalJson } from "../shared/canonical-json.js";
import { sha256 } from "../shared/sha256.js";
import type { CanonicalTaskRecord } from "./task-records.js";

export function semanticHash(records: readonly CanonicalTaskRecord[]): `sha256:${string}` {
  return sha256(canonicalJson(records));
}

