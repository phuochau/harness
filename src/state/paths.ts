import { isAbsolute, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { execa } from "execa";
import type { RunPaths } from "./types.js";

export async function resolveRunPaths(
  repository: string,
  runId: string,
): Promise<RunPaths> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`invalid run ID: ${runId}`);
  }
  const canonicalRepository = await realpath(repository);
  const result = await execa("git", ["rev-parse", "--git-common-dir"], {
    cwd: canonicalRepository,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`cannot resolve Git common directory: ${result.stderr}`);
  }
  const rawCommonDir = result.stdout.trim();
  const commonDir = await realpath(
    isAbsolute(rawCommonDir)
      ? rawCommonDir
      : resolve(canonicalRepository, rawCommonDir),
  );
  const root = join(commonDir, "harness", "runs", runId);
  return {
    repository: canonicalRepository,
    commonDir,
    root,
    manifest: join(root, "run.json"),
    events: join(root, "events.jsonl"),
    state: join(root, "state.json"),
    lease: join(root, "lease.json"),
    lockDir: join(root, "controller.lock"),
    artifacts: join(root, "artifacts"),
    assignments: join(root, "assignments"),
    workers: join(root, "workers"),
    evidence: join(root, "evidence"),
    logs: join(root, "logs"),
  };
}
