import { posix } from "node:path";

export const DefaultProtectedPaths = [
  "spec.md",
  "plan.md",
  "tasks.md",
  "task-graph.json",
  ".harness/**",
  ".pi/**",
] as const;

export function isProtectedPath(path: string): boolean {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  return (
    ["spec.md", "plan.md", "tasks.md", "task-graph.json"].includes(
      posix.basename(normalized),
    ) ||
    normalized === ".harness" ||
    normalized.startsWith(".harness/") ||
    normalized === ".pi" ||
    normalized.startsWith(".pi/")
  );
}

export function matchesAllowedPath(
  path: string,
  allowedPaths: readonly string[],
): boolean {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  return allowedPaths.some((allowed) => {
    if (allowed.endsWith("/**")) {
      const prefix = allowed.slice(0, -3);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return normalized === allowed;
  });
}
