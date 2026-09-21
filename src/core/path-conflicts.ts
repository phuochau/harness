import { posix } from "node:path";

const protectedNames = new Set([
  "spec.md",
  "plan.md",
  "tasks.md",
  "task-graph.json",
]);

export function normalizeOwnedPath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    /[*?\[\]{}]/.test(path)
  ) {
    throw new Error(`invalid owned path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith(".harness/") ||
    normalized === ".harness" ||
    normalized.startsWith(".pi/") ||
    normalized === ".pi" ||
    protectedNames.has(posix.basename(normalized))
  ) {
    throw new Error(`protected or escaping owned path: ${path}`);
  }
  return normalized;
}

export function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  );
}
