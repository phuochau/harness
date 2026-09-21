import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedProfile } from "../config/profiles.js";
import type {
  AcceptedPlanningArtifacts,
  PlanningAgent,
  PlanningArtifactSealer,
  PlanningAttemptReceipt,
  PlanningEnqueueContext,
  PlanningObservation,
  PlanningRequest,
  PlanningRunReceipt,
} from "../ports/planning.js";
import type { ManagedProfileView } from "../runtime/managed/materialize.js";
import type { PiProcessRecord, PiProcessSupervisor } from "../runtime/pi-process/types.js";
import { buildPiLaunchSpec } from "../runtime/pi-worker/launch-spec.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { sha256 } from "../shared/sha256.js";
import { planningArtifactContract, validatePlanningArtifacts } from "../speckit/artifacts.js";

export interface ChildPiPlanningPortOptions {
  readonly root: string;
  readonly profile: ResolvedProfile;
  readonly managed: ManagedProfileView;
  readonly supervisor: PiProcessSupervisor;
  readonly piExecutable: string;
  readonly piExecutableArgs?: readonly string[];
  readonly transportExtensionPath: string;
  readonly sessionRoot: string;
  readonly sealer?: PlanningArtifactSealer;
}

function planningPrompt(request: PlanningRequest, instruction?: string): string {
  const contract = planningArtifactContract(request.stage, request.artifactPaths);
  return [
    `Execute ${request.command} as the Spec Kit planning stage.`,
    `Correlation: harness-planning:${request.correlationId}`,
    `Stage: ${request.stage}`,
    `Required artifacts: ${contract.required.map((name) => request.artifactPaths[name]).join(", ")}`,
    `Only change: ${contract.mustChange.map((name) => request.artifactPaths[name]).join(", ")}`,
    "Spec Kit artifacts are the source of truth. Do not alter architecture outside this stage.",
    instruction?.trim() ?? "",
  ].filter(Boolean).join("\n");
}

async function currentHash(root: string, path: string): Promise<string | null> {
  try {
    return sha256(await readFile(join(root, path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function beforeHashes(request: PlanningRequest): Readonly<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const path of Object.values(request.artifactPaths)) {
    result[path] = request.baseline.hashes[path] ?? null;
  }
  return result;
}

export class ChildPiPlanningPort implements PlanningAgent {
  public constructor(private readonly options: ChildPiPlanningPortOptions) {
    if (options.profile.role !== "planning" || options.profile.runtime !== "pi") {
      throw new Error("child planning requires a Pi planning profile");
    }
  }

  public async prepare(
    request: PlanningRequest,
    context: PlanningEnqueueContext = {},
  ): Promise<PlanningRunReceipt> {
    const generation = 1;
    const sessionId = randomUUID();
    const sessionPath = join(this.options.sessionRoot, `${request.correlationId}-${generation}`);
    const attemptId = `planning:${request.correlationId}:${generation}`;
    return deepFreeze({
      correlationId: request.correlationId,
      generation,
      sessionFile: join(sessionPath, "events.jsonl"),
      requestEntryId: attemptId,
      profileId: this.options.profile.id,
      profileHash: this.options.profile.hash,
      sessionId,
      sessionPath,
      attemptToken: randomUUID(),
      request,
      instruction: context.instruction,
    } as PlanningRunReceipt & { readonly instruction?: string });
  }

  private async processFor(receipt: PlanningRunReceipt): Promise<PiProcessRecord | undefined> {
    if (receipt.process !== undefined) return receipt.process;
    try {
      const path = join(receipt.sessionPath!, "process.json");
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
        throw new Error("planning process record is not a bounded regular file");
      }
      const process = JSON.parse(await readFile(path, "utf8")) as PiProcessRecord;
      if (
        process.attemptId !== receipt.requestEntryId ||
        process.attemptToken !== receipt.attemptToken ||
        process.sessionId !== receipt.sessionId ||
        process.sessionDir !== receipt.sessionPath
      ) throw new Error("planning process record identity mismatch");
      return process;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async launchPrepared(receipt: PlanningRunReceipt): Promise<PlanningRunReceipt> {
    this.validateReceipt(receipt);
    const existing = await this.processFor(receipt);
    if (existing !== undefined) return deepFreeze({ ...receipt, process: existing });
    const extended = receipt as PlanningRunReceipt & { readonly instruction?: string };
    const launch = buildPiLaunchSpec({
      attemptId: receipt.requestEntryId,
      attemptToken: receipt.attemptToken,
      piExecutable: this.options.piExecutable,
      ...(this.options.piExecutableArgs === undefined ? {} : { piExecutableArgs: this.options.piExecutableArgs }),
      profile: this.options.profile,
      managed: this.options.managed,
      transportExtensionPath: this.options.transportExtensionPath,
      cwd: this.options.root,
      sessionId: receipt.sessionId,
      sessionDir: receipt.sessionPath,
      prompt: planningPrompt(receipt.request, extended.instruction),
    });
    const process = await this.options.supervisor.launch(launch);
    return deepFreeze({ ...receipt, process });
  }

  public async enqueue(
    request: PlanningRequest,
    context: PlanningEnqueueContext = {},
  ): Promise<PlanningRunReceipt> {
    return this.launchPrepared(await this.prepare(request, context));
  }

  private validateReceipt(receipt: PlanningRunReceipt): asserts receipt is PlanningRunReceipt & {
    readonly profileId: string;
    readonly profileHash: string;
    readonly sessionId: string;
    readonly sessionPath: string;
    readonly request: PlanningRequest;
    readonly attemptToken: string;
  } {
    if (
      receipt.profileId !== this.options.profile.id ||
      receipt.profileHash !== this.options.profile.hash ||
      receipt.request === undefined || typeof receipt.attemptToken !== "string" ||
      receipt.sessionId === undefined || receipt.sessionPath === undefined ||
      receipt.request.correlationId !== receipt.correlationId
    ) throw new Error("invalid or mismatched child planning receipt");
  }

  public async observe(receipt: PlanningRunReceipt): Promise<PlanningObservation> {
    this.validateReceipt(receipt);
    const process = await this.processFor(receipt);
    if (process === undefined) return { status: "pending" };
    const observation = await this.options.supervisor.observe(process);
    if (observation.status === "running") return { status: "pending" };
    if (observation.status === "missing") {
      return { status: "blocked", reason: "planning process disappeared without terminal evidence", evidence: [process.recordPath] };
    }
    if (observation.status === "identity_mismatch") {
      return { status: "blocked", reason: "planning process identity mismatch", evidence: observation.evidence };
    }
    const terminal = observation.exit.terminal;
    if (
      (observation.exit.exitCode !== null && observation.exit.exitCode !== 0) ||
      observation.exit.signal !== null || !terminal.settled ||
      !terminal.acceptedStopReason || !terminal.completeToolResults ||
      terminal.terminalEventHash === undefined
    ) {
      return {
        status: "blocked",
        reason: "planning attempt has no accepted terminal boundary",
        evidence: [process.eventsPath],
      };
    }
    try {
      const contract = planningArtifactContract(receipt.request.stage, receipt.request.artifactPaths);
      const stageArtifacts = await validatePlanningArtifacts(
        this.options.root,
        contract,
        receipt.request.baseline,
      );
      const allowed = new Set(contract.mustChange.map((name) => receipt.request!.artifactPaths[name]));
      if (contract.deriveGraph) allowed.add(receipt.request.artifactPaths.graph);
      for (const path of Object.values(receipt.request.artifactPaths)) {
        if (allowed.has(path)) continue;
        const before = receipt.request.baseline.hashes[path] ?? null;
        if (await currentHash(this.options.root, path) !== before) {
          throw new Error(`unexpected planning artifact changed: ${path}`);
        }
      }
      let artifacts: AcceptedPlanningArtifacts = stageArtifacts;
      if (receipt.request.stage === "tasks") {
        if (this.options.sealer === undefined) throw new Error("task planning requires a planning artifact sealer");
        const sealed = await this.options.sealer.sealPlanningArtifacts(stageArtifacts.hashes);
        artifacts = { ...stageArtifacts, commit: sealed.commit };
      }
      const finalReceipt: PlanningAttemptReceipt = {
        profileId: receipt.profileId,
        profileHash: receipt.profileHash,
        sessionId: receipt.sessionId,
        sessionPath: receipt.sessionPath,
        correlationId: receipt.correlationId,
        generation: receipt.generation,
        terminalEventHash: terminal.terminalEventHash,
        beforeHashes: beforeHashes(receipt.request),
        afterHashes: stageArtifacts.hashes,
      };
      return deepFreeze({ status: "completed" as const, correlationId: receipt.correlationId, artifacts, receipt: finalReceipt });
    } catch (error) {
      return deepFreeze({
        status: "blocked" as const,
        reason: error instanceof Error ? error.message : String(error),
        evidence: [process.eventsPath, receipt.sessionPath],
      });
    }
  }

  public async run(request: PlanningRequest, context: PlanningEnqueueContext = {}): Promise<PlanningAttemptReceipt> {
    const receipt = await this.enqueue(request, context);
    if (receipt.process === undefined) throw new Error("child planning receipt has no process");
    await this.options.supervisor.wait(receipt.process);
    const observed = await this.observe(receipt);
    if (observed.status !== "completed" || observed.receipt === undefined) {
      throw new Error(observed.status === "blocked" ? observed.reason : "planning attempt did not settle");
    }
    return observed.receipt;
  }
}

export class RoutedChildPiPlanningPort implements PlanningAgent {
  public constructor(
    private readonly routes: Readonly<Record<string, string>>,
    private readonly ports: Readonly<Record<string, ChildPiPlanningPort>>,
  ) {}

  public prepare(request: PlanningRequest, context?: PlanningEnqueueContext): Promise<PlanningRunReceipt> {
    const profileId = this.routes[request.stage];
    const port = profileId === undefined ? undefined : this.ports[profileId];
    if (port === undefined) throw new Error(`no managed Pi planning profile for ${request.stage}`);
    return port.prepare(request, context);
  }

  public launchPrepared(receipt: PlanningRunReceipt): Promise<PlanningRunReceipt> {
    const port = receipt.profileId === undefined ? undefined : this.ports[receipt.profileId];
    if (port === undefined) throw new Error("prepared planning receipt references an unavailable profile");
    return port.launchPrepared(receipt);
  }

  public enqueue(request: PlanningRequest, context?: PlanningEnqueueContext): Promise<PlanningRunReceipt> {
    const profileId = this.routes[request.stage];
    const port = profileId === undefined ? undefined : this.ports[profileId];
    if (port === undefined) throw new Error(`no managed Pi planning profile for ${request.stage}`);
    return port.enqueue(request, context);
  }

  public observe(receipt: PlanningRunReceipt): Promise<PlanningObservation> {
    const port = receipt.profileId === undefined ? undefined : this.ports[receipt.profileId];
    if (port === undefined) {
      return Promise.resolve({
        status: "blocked",
        reason: "planning receipt references an unavailable profile",
        evidence: [receipt.profileId ?? "missing-profile"],
      });
    }
    return port.observe(receipt);
  }
}
