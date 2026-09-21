import type {
  AcceptedPlanningArtifacts,
  ExistingApprovedArtifactBinder,
  PlanningAgent,
  PlanningArtifactSealer,
  PlanningEnqueueContext,
  PlanningObservation,
  PlanningRequest,
  PlanningRunReceipt,
} from "../ports/planning.js";
import { PiPlanningCorrelation } from "../pi/planning-agent.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  planningArtifactContract,
  validatePlanningArtifacts,
} from "./artifacts.js";

export interface PlanningActionOptions {
  readonly root: string;
  readonly correlation: PiPlanningCorrelation;
  readonly sealer?: PlanningArtifactSealer;
}

export class PlanningAction implements PlanningAgent {
  public constructor(private readonly options: PlanningActionOptions) {}

  public enqueue(
    request: PlanningRequest,
    context: PlanningEnqueueContext = {},
  ): Promise<PlanningRunReceipt> {
    return this.options.correlation.enqueue(request, context);
  }

  public execute(
    request: PlanningRequest,
    context: PlanningEnqueueContext = {},
  ): Promise<PlanningRunReceipt> {
    return this.enqueue(request, context);
  }

  public async observe(receipt: PlanningRunReceipt): Promise<PlanningObservation> {
    const settlement = await this.options.correlation.observe(receipt);
    if (settlement.status === "pending" || settlement.status === "blocked") {
      return settlement;
    }
    const pending = await this.options.correlation.request(receipt);
    if (pending === undefined) {
      return {
        status: "blocked",
        reason: "missing durable planning request",
        evidence: [receipt.correlationId, receipt.requestEntryId],
      };
    }
    try {
      const stageArtifacts = await validatePlanningArtifacts(
        this.options.root,
        planningArtifactContract(pending.stage, pending.artifactPaths),
        pending.baseline,
      );
      let artifacts: AcceptedPlanningArtifacts = stageArtifacts;
      if (pending.stage === "tasks") {
        if (this.options.sealer === undefined) {
          throw new Error("task planning requires a planning artifact sealer");
        }
        const sealed = await this.options.sealer.sealPlanningArtifacts(
          stageArtifacts.hashes,
        );
        artifacts = { ...stageArtifacts, commit: sealed.commit };
      }
      return deepFreeze({
        status: "completed" as const,
        correlationId: receipt.correlationId,
        artifacts,
      });
    } catch (error) {
      return deepFreeze({
        status: "blocked" as const,
        reason: error instanceof Error ? error.message : String(error),
        evidence: [
          receipt.sessionFile,
          receipt.requestEntryId,
          String(settlement.finalTurnIndex),
        ],
      });
    }
  }

  public async acceptExistingApproved(
    request: PlanningRequest,
    binder: ExistingApprovedArtifactBinder,
  ): Promise<PlanningObservation> {
    try {
      const contract = {
        ...planningArtifactContract(request.stage, request.artifactPaths),
        required: ["spec", "plan", "tasks", "graph"] as const,
        mustChange: [] as const,
        deriveGraph: false,
        validateGraph: true,
      };
      const stageArtifacts = await validatePlanningArtifacts(
        this.options.root,
        contract,
        { hashes: {} },
      );
      const paths = Object.values(stageArtifacts.files)
        .filter((file) => file !== undefined)
        .map((file) => file.path)
        .sort();
      const bound = await binder.bindExistingApproved(paths, stageArtifacts.hashes);
      return deepFreeze({
        status: "completed" as const,
        correlationId: request.correlationId,
        artifacts: { ...stageArtifacts, commit: bound.commit },
      });
    } catch (error) {
      return deepFreeze({
        status: "blocked" as const,
        reason: error instanceof Error ? error.message : String(error),
        evidence: ["existing-approved", request.correlationId],
      });
    }
  }
}
