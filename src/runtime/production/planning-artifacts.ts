import type { TaskGraphDocument } from "../../contracts/task-graph.js";
import { validateTaskGraph } from "../../contracts/task-graph.js";
import { validateGraph, type ValidatedTaskGraph } from "../../core/task-graph.js";
import type { NativeGitActionPort } from "../../git/action-port.js";
import type { WorktreeLifecycle } from "../../git/workspace-lifecycle.js";
import type { LifecycleWorktreeBinding } from "../../git/worktrees.js";
import type { PlanningArtifactSealer } from "../../ports/planning.js";
import { semanticHash } from "../../speckit/semantic-hash.js";
import { parseSpecKitTasks } from "../../speckit/task-records.js";
import type { RunManifest } from "../../state/run-manifest.js";
import { canonicalJson } from "../../shared/canonical-json.js";

function acceptanceReferences(spec: string): ReadonlySet<string> {
  return new Set(
    [...spec.replace(/\r\n/g, "\n").matchAll(/^\s*[-*]\s+((?:FR|SC)-[0-9]{3}):/gm)]
      .map((match) => match[1]!),
  );
}

export async function loadRunTaskGraph(
  git: NativeGitActionPort,
  manifest: RunManifest,
): Promise<ValidatedTaskGraph> {
  const [spec, tasks, graphText] = await Promise.all([
    git.readTextAt(manifest.runRef, manifest.artifactPaths.spec),
    git.readTextAt(manifest.runRef, manifest.artifactPaths.tasks),
    git.readTextAt(manifest.runRef, manifest.artifactPaths.graph),
  ]);
  const taskRecords = parseSpecKitTasks(tasks);
  const graph = validateTaskGraph(JSON.parse(graphText)) as TaskGraphDocument;
  return validateGraph(graph, {
    tasksSemanticHash: semanticHash(taskRecords),
    taskRecords: new Map(taskRecords.map((task) => [task.id, task] as const)),
    acceptanceRefs: acceptanceReferences(spec),
  });
}

export class ProductionPlanningArtifactSealer implements PlanningArtifactSealer {
  public constructor(
    private readonly manifest: RunManifest,
    private readonly binding: LifecycleWorktreeBinding,
    private readonly worktrees: WorktreeLifecycle,
    private readonly git: NativeGitActionPort,
  ) {}

  public async sealPlanningArtifacts(
    hashes: Readonly<Record<string, string>>,
  ): Promise<{ readonly commit: string; readonly hashes: Readonly<Record<string, string>> }> {
    const existing = this.worktrees.sealedHead(this.binding);
    const sealed = existing === undefined
      ? await this.worktrees.sealPlanningArtifacts(this.binding, hashes)
      : { commit: existing, hashes: await this.worktrees.hashFiles(this.binding.path, Object.keys(hashes)) };
    if (canonicalJson(sealed.hashes) !== canonicalJson(hashes)) {
      throw new Error("sealed planning artifact hashes changed");
    }
    const current = await this.git.revParse(this.manifest.runRef);
    if (current === this.manifest.frozenBase) {
      await this.git.updateRefCas(
        this.manifest.runRef,
        sealed.commit,
        this.manifest.frozenBase,
      );
    } else if (current !== sealed.commit) {
      throw new Error(`run ref changed before planning seal: ${current}`);
    }
    return sealed;
  }
}
