import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  EffectIntent,
  ReconcileResult,
} from "../../actions/types.js";
import type { WorkerKind } from "../../core/routing.js";
import {
  validateWorkerResult,
  type WorkerResult,
} from "../../contracts/worker-result.js";
import { NodeProcessRunner } from "../../git/process.js";
import type { HerdrEvent } from "./client.js";
import { HerdrEventTracker, type AgentLifecycleObservation } from "./events.js";
import {
  identityMismatchEvidence,
  type AttemptIdentity,
} from "./identity.js";
import type { HerdrMethod } from "./protocol.generated.js";

export interface HerdrControlClient {
  request<M extends HerdrMethod>(
    method: M,
    params: any,
  ): Promise<any>;
  subscribe(listener: (event: HerdrEvent) => void): () => void;
}

export interface RuntimeEvidence {
  worktreeCommit(path: string): Promise<string>;
  readResult(path: string): Promise<WorkerResult | undefined>;
}

export class FileRuntimeEvidence implements RuntimeEvidence {
  private readonly process = new NodeProcessRunner();

  public async worktreeCommit(path: string): Promise<string> {
    const result = await this.process.run("git", ["rev-parse", "HEAD"], {
      cwd: path,
      shell: false,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  public async readResult(path: string): Promise<WorkerResult | undefined> {
    try {
      return validateWorkerResult(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export interface WorkspaceRequest {
  readonly worktreePath: string;
  readonly assignedCommit: string;
  readonly label: string;
  readonly branch?: string | null;
  readonly expectedWorkspaceId?: string;
  readonly expectedPaneId?: string;
}

export interface WorkspaceHandle {
  readonly workspaceId: string;
  readonly paneId: string;
  readonly worktreePath: string;
  readonly assignedCommit: string;
}

export interface WorkerStartInput {
  readonly identity: AttemptIdentity;
  readonly agentName: string;
  readonly workerKind: WorkerKind;
  readonly args: readonly string[];
}

export type WorkerStartIntent = EffectIntent<"worker.start", WorkerStartInput>;

export interface WorkerHandle extends WorkspaceHandle {
  readonly agentName: string;
  readonly workerKind: WorkerKind;
  readonly status: string;
}

export interface SubmitAssignmentInput {
  readonly identity: AttemptIdentity;
  readonly agentName: string;
  readonly prompt: string;
  readonly resultPath: string;
}

export type SubmitAssignmentIntent = EffectIntent<
  "worker.submit",
  SubmitAssignmentInput
>;

export interface AssignmentSubmission {
  readonly acknowledged: true;
  readonly assignmentHash: string;
  readonly reconciledByResult: boolean;
  readonly result?: WorkerResult;
}

export class HerdrRuntimeInvariantError extends Error {}

function records(value: unknown, key: string): readonly Record<string, any>[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as Record<string, unknown>)[key])
  ) {
    throw new HerdrRuntimeInvariantError(`Herdr response is missing ${key}`);
  }
  return (value as Record<string, any>)[key];
}

function record(value: unknown, key: string): Record<string, any> {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>)[key] !== "object" ||
    (value as Record<string, unknown>)[key] === null
  ) {
    throw new HerdrRuntimeInvariantError(`Herdr response is missing ${key}`);
  }
  return (value as Record<string, any>)[key];
}

function notFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "not_found"
  );
}

export class HerdrRuntime {
  private readonly events = new HerdrEventTracker();

  public constructor(
    private readonly client: HerdrControlClient,
    private readonly evidence: RuntimeEvidence = new FileRuntimeEvidence(),
  ) {
    client.subscribe((event) => this.events.observe(event));
  }

  private async assertCommit(path: string, expected: string): Promise<void> {
    const observed = await this.evidence.worktreeCommit(path);
    if (observed !== expected) {
      throw new HerdrRuntimeInvariantError(
        `worktree commit mismatch: expected ${expected}, observed ${observed}`,
      );
    }
  }

  private async workspaceFor(identity: AttemptIdentity): Promise<Record<string, any> | undefined> {
    const response = await this.client.request("workspace.list", {});
    return records(response, "workspaces").find(
      (workspace) => workspace.workspace_id === identity.workspaceId,
    );
  }

  private async assertWorkspaceBinding(identity: AttemptIdentity): Promise<void> {
    const workspace = await this.workspaceFor(identity);
    if (workspace === undefined) {
      throw new HerdrRuntimeInvariantError(`workspace ${identity.workspaceId} is missing`);
    }
    const checkout = workspace.worktree?.checkout_path;
    if (typeof checkout !== "string" || resolve(checkout) !== resolve(identity.worktreePath)) {
      throw new HerdrRuntimeInvariantError(
        `workspace worktree mismatch: ${String(checkout)}`,
      );
    }
    await this.assertCommit(identity.worktreePath, identity.assignedCommit);
  }

  public async ensureWorkspace(input: WorkspaceRequest): Promise<WorkspaceHandle> {
    await this.assertCommit(input.worktreePath, input.assignedCommit);
    const listed = await this.client.request("workspace.list", {});
    const existing = records(listed, "workspaces").find(
      (workspace) =>
        typeof workspace.worktree?.checkout_path === "string" &&
        resolve(workspace.worktree.checkout_path) === resolve(input.worktreePath),
    );
    if (existing !== undefined) {
      const workspaceId = String(existing.workspace_id);
      if (
        input.expectedWorkspaceId !== undefined &&
        input.expectedWorkspaceId !== workspaceId
      ) {
        throw new HerdrRuntimeInvariantError("workspace identity changed");
      }
      const paneList = await this.client.request("pane.list", {
        workspace_id: workspaceId,
      });
      const panes = records(paneList, "panes");
      const pane = input.expectedPaneId === undefined
        ? panes[0]
        : panes.find((item) => item.pane_id === input.expectedPaneId);
      if (pane === undefined) throw new HerdrRuntimeInvariantError("workspace root pane is missing");
      return {
        workspaceId,
        paneId: String(pane.pane_id),
        worktreePath: input.worktreePath,
        assignedCommit: input.assignedCommit,
      };
    }
    if (input.expectedWorkspaceId !== undefined || input.expectedPaneId !== undefined) {
      throw new HerdrRuntimeInvariantError("persisted Herdr workspace is missing");
    }
    const opened = await this.client.request("worktree.open", {
      path: input.worktreePath,
      label: input.label,
      focus: false,
      trust_repository: true,
    });
    const workspace = record(opened, "workspace");
    const pane = record(opened, "root_pane");
    return {
      workspaceId: String(workspace.workspace_id),
      paneId: String(pane.pane_id),
      worktreePath: input.worktreePath,
      assignedCommit: input.assignedCommit,
    };
  }

  public async reconcile(
    intent: WorkerStartIntent,
  ): Promise<ReconcileResult<WorkerHandle>> {
    if (intent.input.agentName !== intent.input.identity.agentName) {
      return {
        status: "indeterminate",
        evidence: ["agent name does not match immutable attempt identity"],
      };
    }
    if (intent.input.workerKind !== intent.input.identity.workerKind) {
      return {
        status: "indeterminate",
        evidence: ["worker kind does not match immutable attempt identity"],
      };
    }
    const response = await this.client.request("agent.list", {});
    const matches = records(response, "agents").filter(
      (agent) => agent.name === intent.input.agentName,
    );
    if (matches.length === 0) return { status: "not_found" };
    if (matches.length !== 1) {
      return { status: "indeterminate", evidence: ["duplicate native agent name"] };
    }
    const agent = matches[0]!;
    const mismatch = [...identityMismatchEvidence(agent, intent.input.identity)];
    try {
      await this.assertWorkspaceBinding(intent.input.identity);
    } catch (error) {
      mismatch.push(error instanceof Error ? error.message : String(error));
    }
    if (mismatch.length > 0) {
      return { status: "indeterminate", evidence: mismatch };
    }
    return {
      status: "observed",
      output: {
        agentName: intent.input.agentName,
        workerKind: intent.input.workerKind,
        workspaceId: intent.input.identity.workspaceId,
        paneId: intent.input.identity.paneId,
        worktreePath: intent.input.identity.worktreePath,
        assignedCommit: intent.input.identity.assignedCommit,
        status: String(agent.agent_status),
      },
    };
  }

  public async startAgent(intent: WorkerStartIntent): Promise<WorkerHandle> {
    const prior = await this.reconcile(intent);
    if (prior.status === "observed") return prior.output;
    if (prior.status === "indeterminate") {
      throw new HerdrRuntimeInvariantError(prior.evidence.join("; "));
    }
    await this.assertWorkspaceBinding(intent.input.identity);
    const paneResponse = await this.client.request("pane.get", {
      pane_id: intent.input.identity.paneId,
    });
    const pane = record(paneResponse, "pane");
    if (
      pane.pane_id !== intent.input.identity.paneId ||
      pane.workspace_id !== intent.input.identity.workspaceId ||
      (pane.agent !== null && pane.agent !== undefined)
    ) {
      throw new HerdrRuntimeInvariantError("assigned pane is not an available shell pane");
    }
    const processResponse = await this.client.request("pane.process_info", {
      pane_id: intent.input.identity.paneId,
    });
    const processInfo = record(processResponse, "process_info");
    if (
      !Array.isArray(processInfo.foreground_processes) ||
      processInfo.foreground_processes.length > 0
    ) {
      throw new HerdrRuntimeInvariantError("assigned pane is not back at its interactive shell");
    }
    const started = await this.client.request("agent.start", {
      name: intent.input.agentName,
      kind: intent.input.workerKind,
      pane_id: intent.input.identity.paneId,
      args: [...intent.input.args],
    });
    const agent = record(started, "agent");
    const mismatch = identityMismatchEvidence(agent, intent.input.identity);
    if (mismatch.length > 0) {
      throw new HerdrRuntimeInvariantError(mismatch.join("; "));
    }
    return {
      agentName: intent.input.agentName,
      workerKind: intent.input.workerKind,
      workspaceId: intent.input.identity.workspaceId,
      paneId: intent.input.identity.paneId,
      worktreePath: intent.input.identity.worktreePath,
      assignedCommit: intent.input.identity.assignedCommit,
      status: String(agent.agent_status),
    };
  }

  public async submitAssignment(
    intent: SubmitAssignmentIntent,
  ): Promise<AssignmentSubmission> {
    let response: any;
    try {
      response = await this.client.request("agent.get", {
        target: intent.input.agentName,
      });
    } catch (error) {
      if (notFound(error)) throw new HerdrRuntimeInvariantError("assigned agent is missing");
      throw error;
    }
    const agent = record(response, "agent");
    if (
      agent.name !== intent.input.agentName ||
      agent.pane_id !== intent.input.identity.paneId ||
      agent.workspace_id !== intent.input.identity.workspaceId ||
      agent.agent_status !== "idle"
    ) {
      throw new HerdrRuntimeInvariantError("assignment target is not the expected idle agent");
    }
    await this.client.request("agent.prompt", {
      target: intent.input.agentName,
      text: intent.input.prompt,
    });
    return {
      acknowledged: true,
      assignmentHash: intent.input.identity.assignmentHash,
      reconciledByResult: false,
    };
  }

  public async recoverSubmit(
    intent: SubmitAssignmentIntent,
  ): Promise<ReconcileResult<AssignmentSubmission>> {
    let result: WorkerResult | undefined;
    try {
      result = await this.evidence.readResult(intent.input.resultPath);
    } catch (error) {
      return {
        status: "indeterminate",
        evidence: [`structured result is invalid: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    if (result === undefined) {
      return {
        status: "indeterminate",
        evidence: ["prompt delivery is ambiguous and no structured result exists"],
      };
    }
    if (result.assignmentHash !== intent.input.identity.assignmentHash) {
      return {
        status: "indeterminate",
        evidence: ["structured result assignment hash mismatch"],
      };
    }
    return {
      status: "observed",
      output: {
        acknowledged: true,
        assignmentHash: result.assignmentHash,
        reconciledByResult: true,
        result,
      },
    };
  }

  public async observeAgent(
    expected: WorkerHandle,
  ): Promise<WorkerHandle | undefined> {
    try {
      const response = await this.client.request("agent.get", {
        target: expected.agentName,
      });
      const agent = record(response, "agent");
      if (
        agent.name !== expected.agentName ||
        agent.agent !== expected.workerKind ||
        agent.workspace_id !== expected.workspaceId ||
        agent.pane_id !== expected.paneId
      ) {
        throw new HerdrRuntimeInvariantError(
          "observed agent no longer matches its persisted native identity",
        );
      }
      return {
        ...expected,
        status: String(agent.agent_status),
      };
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  }

  public async waitForAgent(
    handle: WorkerHandle,
    timeoutMs = 86_400_000,
  ): Promise<void> {
    await this.client.request("agent.wait", {
      target: handle.agentName,
      until: ["idle", "blocked", "done"],
      timeout_ms: timeoutMs,
    });
  }

  public async closeWorkspace(workspaceId: string): Promise<void> {
    const existing = records(
      await this.client.request("workspace.list", {}),
      "workspaces",
    ).some((workspace) => workspace.workspace_id === workspaceId);
    if (!existing) return;
    await this.client.request("workspace.close", {
      workspace_id: workspaceId,
      close_group: false,
    });
  }

  public async stopAgent(handle: WorkerHandle): Promise<void> {
    await this.client.request("agent.send_keys", {
      target: handle.agentName,
      keys: ["ctrl+c"],
    });
    await this.client.request("agent.wait", {
      target: handle.agentName,
      until: ["idle", "done"],
      timeout_ms: 30_000,
    });
    const agents = records(await this.client.request("agent.list", {}), "agents");
    if (
      agents.some(
        (agent) =>
          agent.name === handle.agentName || agent.pane_id === handle.paneId,
      )
    ) {
      throw new HerdrRuntimeInvariantError("stopped agent still owns its pane");
    }
  }

  public latestAgentObservation(
    paneId: string,
  ): AgentLifecycleObservation | undefined {
    return this.events.latest(paneId);
  }
}
