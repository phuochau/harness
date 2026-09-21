import type { LockedDependency } from "../contracts/lock.js";
import type { TrustedSource } from "./types.js";

export interface AutomaticInstallRecipe {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: "trusted-install-root";
  readonly scope: "project" | "global";
  readonly expectedMutations: readonly string[];
  readonly rollback: string;
}

export type InstallRecipe =
  | { readonly mode: "automatic"; readonly recipe: AutomaticInstallRecipe }
  | { readonly mode: "manual"; readonly reason: string };

function exactPiSource(dependency: LockedDependency, source: TrustedSource): string | undefined {
  if (source.kind !== "npm") return undefined;
  const expected = `npm:${source.identity}@${source.version}`;
  return dependency.piSource === expected ? expected : undefined;
}

export function recipeFor(
  dependency: LockedDependency,
  source: TrustedSource,
): InstallRecipe {
  if (dependency.kind === "pi-package") {
    const piSource = exactPiSource(dependency, source);
    if (piSource === undefined) {
      return {
        mode: "manual",
        reason: "Pi package source is not an exact locked npm source",
      };
    }
    return {
      mode: "automatic",
      recipe: {
        executable: "pi",
        argv: ["install", "-l", piSource],
        cwd: "trusted-install-root",
        scope: "project",
        expectedMutations: [".pi/settings.json", ".pi/npm/**"],
        rollback: `pi remove ${piSource}`,
      },
    };
  }

  if (source.kind === "npm") {
    return {
      mode: "automatic",
      recipe: {
        executable: "npm",
        argv: [
          "install",
          "--global",
          "--ignore-scripts",
          `${source.identity}@${source.version}`,
        ],
        cwd: "trusted-install-root",
        scope: "global",
        expectedMutations: ["global npm prefix"],
        rollback: `npm uninstall --global ${source.identity}`,
      },
    };
  }

  if (source.kind === "git" && /^[0-9a-f]{40}$/i.test(source.version)) {
    return {
      mode: "manual",
      reason: "Commit-pinned Git source has no declared non-interactive installer",
    };
  }

  return {
    mode: "manual",
    reason: `No verified automatic recipe for ${source.kind} source`,
  };
}
