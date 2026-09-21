import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import type { PiProcessSupervisor } from "../runtime/pi-process/types.js";
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

  public async enqueue(
    request: PlanningRequest,
    context: PlanningEnqueueContext = {},
  ): Promise<PlanningRunReceipt> {
    const generation = 1;
    const sessionId = randomUUID();
    const sessionPath = join(this.options.sessionRoot, `${request.correlationId}-${generation}`);
    const launch = buildPiLaunchSpec({
      attemptId: `planning:${request.correlationId}:${generation}`,
      attemptToken: randomUUID(),
      piExecutable: this.options.piExecutable,
      profile: this.options.profile,
      managed: this.options.managed,
      transportExtensionPath: this.options.transportExtensionPath,
      cwd: this.options.root,
      sessionId,
      sessionDir: sessionPath,
      prompt: planningPrompt(request, context.instruction),
    });
    const process = await this.options.supervisor.launch(launch);
    return deepFreeze({
      correlationId: request.correlationId,
      generation,
      sessionFile: join(sessionPath, "events.jsonl"),
      requestEntryId: launch.attemptId,
      profileId: this.options.profile.id,
      profileHash: this.options.profile.hash,
      sessionId,
      sessionPath,
      process,
      request,
    });
  }

  private validateReceipt(receipt: PlanningRunReceipt): asserts receipt is PlanningRunReceipt & {
    readonly profileId: string;
    readonly profileHash: string;
    readonly sessionId: string;
    readonly sessionPath: string;
    readonly process: NonNullable<PlanningRunReceipt["process"]>;
    readonly request: PlanningRequest;
  } {
    if (
      receipt.profileId !== this.options.profile.id ||
      receipt.profileHash !== this.options.profile.hash ||
      receipt.process === undefined || receipt.request === undefined ||
      receipt.sessionId === undefined || receipt.sessionPath === undefined ||
      receipt.process.sessionId !== receipt.sessionId ||
      receipt.request.correlationId !== receipt.correlationId
    ) throw new Error("invalid or mismatched child planning receipt");
  }

  public async observe(receipt: PlanningRunReceipt): Promise<PlanningObservation> {
    this.validateReceipt(receipt);
    const observation = await this.options.supervisor.observe(receipt.process);
    if (observation.status === "running") return { status: "pending" };
    if (observation.status === "missing") {
      return { status: "blocked", reason: "planning process disappeared without terminal evidence", evidence: [receipt.process.recordPath] };
    }
    if (observation.status === "identity_mismatch") {
      return { status: "blocked", reason: "planning process identity mismatch", evidence: observation.evidence };
    }
    const terminal = observation.exit.terminal;
    if (
      observation.exit.exitCode !== 0 || !terminal.settled ||
      !terminal.acceptedStopReason || !terminal.completeToolResults ||
      terminal.terminalEventHash === undefined
    ) {
      return {
        status: "blocked",
        reason: "planning attempt has no accepted terminal boundary",
        evidence: [receipt.process.eventsPath],
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
        evidence: [receipt.process.eventsPath, receipt.sessionPath],
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
