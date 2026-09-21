import type { ArtifactPaths } from "../../speckit/artifacts.js";
import { GitRepository } from "../../git/repository.js";
import { planningBranchName, runBranchName } from "../../git/branches.js";
import { sha256 } from "../../shared/sha256.js";
import { resolveRunPaths } from "../../state/paths.js";
import {
  writeRunManifest,
  type RunManifest,
} from "../../state/run-manifest.js";
import type { RunPaths } from "../../state/types.js";

export interface InitializeProductionRunOptions {
  readonly root: string;
  readonly runId: string;
  readonly workflowRevision: `sha256:${string}`;
  readonly approvedPreviewHash: `sha256:${string}`;
  readonly artifactPaths: ArtifactPaths;
  readonly remote: string;
  readonly baseBranch: string;
  readonly now?: () => Date;
}

export interface InitializedProductionRun {
  readonly repository: GitRepository;
  readonly paths: RunPaths;
  readonly manifest: RunManifest;
}

export async function initializeProductionRun(
  options: InitializeProductionRunOptions,
): Promise<InitializedProductionRun> {
  if (!/^[A-Za-z0-9._-]+$/.test(options.remote)) {
    throw new Error("run remote name is unsafe");
  }
  const repository = await GitRepository.open(options.root);
  const inspection = await repository.inspect();
  if (inspection.dirty) {
    throw new Error("production run requires a clean repository");
  }
  const baseCommit = await repository.revParse(`refs/heads/${options.baseBranch}`);
  if (baseCommit !== inspection.head) {
    throw new Error("production run base branch must match the checked-out HEAD");
  }
  const run = await repository.ensureRunBranch(options.runId, inspection.head);
  const planning = await repository.ensurePlanningBranch(options.runId, inspection.head);
  const paths = await resolveRunPaths(inspection.root, options.runId);
  const manifest = await writeRunManifest(paths.manifest, {
    schemaVersion: 1,
    runId: options.runId,
    workflowRevision: options.workflowRevision,
    repositoryRoot: inspection.root,
    repositoryIdentity: sha256(`${inspection.root}\0${inspection.commonDir}`),
    frozenBase: inspection.head,
    runRef: `refs/heads/${runBranchName(options.runId)}`,
    planningRef: `refs/heads/${planningBranchName(options.runId)}`,
    artifactPaths: structuredClone(options.artifactPaths),
    remote: options.remote,
    baseBranch: options.baseBranch,
    approvedPreviewHash: options.approvedPreviewHash,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  });
  if (
    run.commit !== manifest.frozenBase ||
    planning.commit !== manifest.frozenBase
  ) {
    throw new Error("new production run branches do not match the frozen base");
  }
  return { repository, paths, manifest };
}
