import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "../../actions/types.js";
import type { PlanningAgent, PlanningRequest, PlanningRunReceipt } from "../../ports/planning.js";
import { sha256 } from "../../shared/sha256.js";
import type { ArtifactPaths, PlanningStage } from "../../speckit/artifacts.js";
import type { DurableRecordStore } from "./records.js";

export type PlanningActionKind = "spec-kit.specify" | "spec-kit.plan" | "spec-kit.tasks";
export type PlanningEffectInput = Readonly<Record<string, unknown>>;

export interface PlanningActionOutput {
  readonly stage: PlanningStage;
  readonly correlationId: string;
  readonly hashes: Readonly<Record<string, string>>;
  readonly commit?: string;
  readonly sessionFile: string;
  readonly requestEntryId: string;
  readonly command: string;
  readonly profileId?: string;
  readonly profileHash?: string;
  readonly sessionId?: string;
  readonly sessionPath?: string;
  readonly terminalEventHash?: `sha256:${string}`;
}

export interface DurablePlanningActionOptions {
  readonly runId: string;
  readonly root: string;
  readonly artifactPaths: ArtifactPaths;
  readonly records: DurableRecordStore;
  readonly planning: PlanningAgent;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly afterCompleted?: (output: PlanningActionOutput) => Promise<void>;
}

const stageByKind: Readonly<Record<PlanningActionKind, PlanningStage>> = {
  "spec-kit.specify": "specify",
  "spec-kit.plan": "plan",
  "spec-kit.tasks": "tasks",
};

const commandByStage = {
  specify: "/speckit.specify",
  plan: "/speckit.plan",
  tasks: "/speckit.tasks",
} as const;

async function baseline(
  root: string,
  paths: ArtifactPaths,
): Promise<{ readonly hashes: Readonly<Record<string, string>> }> {
  const hashes: Record<string, string> = {};
  for (const path of Object.values(paths)) {
    try {
      hashes[path] = sha256(await readFile(join(root, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { hashes };
}

function receipt(value: unknown): PlanningRunReceipt {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof (value as Record<string, unknown>).correlationId !== "string" ||
    !Number.isInteger((value as Record<string, unknown>).generation) ||
    typeof (value as Record<string, unknown>).sessionFile !== "string" ||
    typeof (value as Record<string, unknown>).requestEntryId !== "string"
  ) {
    throw new Error("invalid durable planning receipt");
  }
  return value as PlanningRunReceipt;
}

export class DurablePlanningAction<K extends PlanningActionKind>
  implements ActionHandler<K, PlanningEffectInput, PlanningActionOutput>
{
  public constructor(
    public readonly kind: K,
    private readonly options: DurablePlanningActionOptions,
  ) {}

  public recovery(_input: PlanningEffectInput): RecoveryClass {
    return "reconcilable";
  }

  private async observe(
    durableReceipt: PlanningRunReceipt,
    idempotencyKey: string,
  ): Promise<ReconcileResult<PlanningActionOutput>> {
    const completed = await this.options.records.get<PlanningActionOutput>(
      "planning-completed",
      idempotencyKey,
    );
    if (completed !== undefined) return { status: "observed", output: completed };
    const observation = await this.options.planning.observe(durableReceipt);
    if (observation.status === "pending") return { status: "not_found" };
    if (observation.status === "blocked") {
      return { status: "indeterminate", evidence: [observation.reason, ...observation.evidence] };
    }
    const stage = stageByKind[this.kind];
    const output: PlanningActionOutput = {
      stage,
      correlationId: observation.correlationId,
      hashes: observation.artifacts.hashes,
      sessionFile: durableReceipt.sessionFile,
      requestEntryId: durableReceipt.requestEntryId,
      command: commandByStage[stage],
      ...(observation.artifacts.commit === undefined
        ? {}
        : { commit: observation.artifacts.commit }),
      ...(observation.receipt === undefined ? {} : {
        profileId: observation.receipt.profileId,
        profileHash: observation.receipt.profileHash,
        sessionId: observation.receipt.sessionId,
        sessionPath: observation.receipt.sessionPath,
        terminalEventHash: observation.receipt.terminalEventHash,
      }),
    };
    return {
      status: "observed",
      output: await this.options.records.put("planning-completed", idempotencyKey, output),
    };
  }

  private async durableReceipt(
    intent: EffectIntent<K, PlanningEffectInput>,
  ): Promise<PlanningRunReceipt | undefined> {
    const value = await this.options.records.get<unknown>(
      "planning-receipt",
      intent.idempotencyKey,
    );
    return value === undefined ? undefined : receipt(value);
  }

  public async execute(
    _context: ActionContext,
    intent: EffectIntent<K, PlanningEffectInput>,
  ): Promise<PlanningActionOutput> {
    const stage = stageByKind[this.kind];
    let durableReceipt = await this.durableReceipt(intent);
    if (durableReceipt === undefined) {
      const request: PlanningRequest = {
        stage,
        command: commandByStage[stage],
        correlationId: `${this.options.runId}-${stage}-${String(intent.input.attempt ?? 1)}`,
        artifactPaths: this.options.artifactPaths,
        baseline: await baseline(this.options.root, this.options.artifactPaths),
      };
      if (
        this.options.planning.prepare !== undefined &&
        this.options.planning.launchPrepared !== undefined
      ) {
        durableReceipt = receipt(await this.options.records.put(
          "planning-receipt",
          intent.idempotencyKey,
          await this.options.planning.prepare(request),
        ));
      } else {
        durableReceipt = receipt(await this.options.records.put(
          "planning-receipt",
          intent.idempotencyKey,
          await this.options.planning.enqueue(request),
        ));
      }
    }
    if (
      durableReceipt.process === undefined &&
      this.options.planning.launchPrepared !== undefined
    ) {
      durableReceipt = receipt(await this.options.planning.launchPrepared(durableReceipt));
    }
    const deadline = Date.now() + (this.options.timeoutMs ?? 86_400_000);
    while (true) {
      const observed = await this.observe(durableReceipt, intent.idempotencyKey);
      if (observed.status === "observed") {
        await this.options.afterCompleted?.(observed.output);
        return observed.output;
      }
      if (observed.status === "indeterminate") {
        throw new Error(observed.evidence.join("; "));
      }
      if (Date.now() >= deadline) throw new Error(`planning stage ${stage} timed out`);
      await new Promise<void>((resolve) => setTimeout(resolve, this.options.pollMs ?? 250));
    }
  }

  public async reconcile(
    _context: ActionContext,
    intent: EffectIntent<K, PlanningEffectInput>,
  ): Promise<ReconcileResult<PlanningActionOutput>> {
    const durableReceipt = await this.durableReceipt(intent);
    if (durableReceipt === undefined) return { status: "not_found" };
    const observed = await this.observe(durableReceipt, intent.idempotencyKey);
    if (observed.status === "observed") {
      await this.options.afterCompleted?.(observed.output);
    }
    return observed;
  }
}
