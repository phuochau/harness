import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { HerdrRemoteError, type HerdrEvent } from "./client.js";
import { HerdrEventTracker, type AgentLifecycleObservation } from "./events.js";
import {
  identityMismatchEvidence,
  type AttemptIdentity,
} from "./identity.js";
import type { HerdrMethod } from "./protocol.generated.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { sha256 } from "../../shared/sha256.js";
import type { HerdrCancellationSpec } from "../workers/types.js";

export interface HerdrControlClient {
  request<M extends HerdrMethod>(
    method: M,
    params: any,
  ): Promise<any>;
  subscribe(listener: (event: HerdrEvent) => void): () => void;
}

export interface RuntimeEvidence {
  worktreeCommit(path: string): Promise<string>;
  sourceCheckout(path: string): Promise<string>;
  readResult(path: string): Promise<WorkerResult | undefined>;
  materializeTranscriptResult?(
    path: string,
    transcript: string,
    assignmentHash: string,
  ): Promise<WorkerResult | undefined>;
}

async function writeExact(path: string, body: string): Promise<void> {
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || await readFile(path, "utf8") !== body) {
      throw new HerdrRuntimeInvariantError(
        `transcript result artifact already exists with different content: ${path}`,
      );
    }
  }
}

function framedTranscriptJson(
  transcript: string,
  marker: string,
  endMarker: string,
): string | undefined {
  let normalized = transcript.replace(/\r\n/g, "\n").trimEnd();
  if (!normalized.endsWith(`\n${endMarker}`)) {
    const lastBreak = normalized.lastIndexOf("\n");
    const trailingLine = lastBreak < 0 ? normalized : normalized.slice(lastBreak + 1);
    const priorLines = lastBreak < 0 ? [] : normalized.slice(0, lastBreak).split("\n");
    if (
      lastBreak < 0 ||
      trailingLine.length === 0 ||
      trailingLine.length > 512 ||
      !priorLines.some((line) =>
        line.startsWith(`${trailingLine} `) && line.length > trailingLine.length + 1)
    ) return undefined;
    normalized = normalized.slice(0, lastBreak).trimEnd();
  }
  if (!normalized.endsWith(`\n${endMarker}`)) return undefined;
  const endOffset = normalized.length - endMarker.length - 1;
  const markerOffset = normalized.lastIndexOf(`\n${marker}`, endOffset);
  const startsWithMarker = normalized.startsWith(marker);
  const start = markerOffset >= 0
    ? markerOffset + 1
    : startsWithMarker ? 0 : -1;
  if (start < 0) return undefined;
  const input = normalized.slice(start + marker.length, endOffset);
  let started = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (!started) {
      if (/\s/.test(character)) continue;
      if (character !== "{") {
        throw new HerdrRuntimeInvariantError("transcript result envelope is invalid JSON");
      }
      started = true;
    }
    if (inString && (character === "\n" || character === "\r")) {
      continue;
    }
    output += character;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0) {
        const remainder = input.slice(index + 1);
        return remainder.trim() === "" ? output : undefined;
      }
    }
  }
  return undefined;
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

  public async sourceCheckout(path: string): Promise<string> {
    const result = await this.process.run(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: path, shell: false },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr);
    const first = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("worktree "));
    if (first === undefined) {
      throw new HerdrRuntimeInvariantError("Git did not report a source checkout");
    }
    return first.slice("worktree ".length);
  }

  public async readResult(path: string): Promise<WorkerResult | undefined> {
    try {
      const outputInfo = await lstat(dirname(path));
      if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
        throw new HerdrRuntimeInvariantError(
          "structured result output directory is not a real directory",
        );
      }
      return validateWorkerResult(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async materializeTranscriptResult(
    path: string,
    transcript: string,
    assignmentHash: string,
  ): Promise<WorkerResult | undefined> {
    const marker = "HARNESS_REVIEW_RESULT_V1 ";
    const framed = framedTranscriptJson(
      transcript,
      marker,
      "HARNESS_REVIEW_RESULT_END_V1",
    );
    if (framed === undefined) return undefined;
    if (framed.length > 256 * 1024) {
      throw new HerdrRuntimeInvariantError("transcript result envelope is too large");
    }
    let envelope: any;
    try {
      envelope = JSON.parse(framed);
    } catch {
      throw new HerdrRuntimeInvariantError("transcript result envelope is invalid JSON");
    }
    if (
      typeof envelope !== "object" || envelope === null || Array.isArray(envelope) ||
      typeof envelope.result !== "object" || envelope.result === null ||
      envelope.result.assignmentHash !== assignmentHash
    ) return undefined;
    const rawEvidence = envelope.evidence;
    if (!Array.isArray(rawEvidence) || rawEvidence.length > 32) {
      throw new HerdrRuntimeInvariantError("transcript result evidence is invalid");
    }
    const output = dirname(path);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const outputInfo = await lstat(output);
    if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
      throw new HerdrRuntimeInvariantError(
        "transcript result output directory is not a real directory",
      );
    }
    const evidence = [];
    for (const [index, item] of rawEvidence.entries()) {
      if (
        typeof item !== "object" || item === null || Array.isArray(item) ||
        typeof item.kind !== "string" || item.kind.length === 0 ||
        typeof item.content !== "string" || item.content.length > 1024 * 1024
      ) {
        throw new HerdrRuntimeInvariantError("transcript result evidence item is invalid");
      }
      const name = `transcript-evidence-${index + 1}.txt`;
      await writeExact(join(output, name), item.content);
      evidence.push({
        kind: item.kind,
        path: `.harness-output/${name}`,
        sha256: sha256(item.content),
      });
    }
    const result = validateWorkerResult({ ...envelope.result, evidence });
    const serialized = `${canonicalJson(result)}\n`;
    await writeExact(path, serialized);
    return result;
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
  readonly resultTransport?: "file" | "transcript";
  readonly deliveredAtLaunch?: boolean;
  readonly deliveryMarker?: string;
  readonly timeoutMs: number;
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
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (code === "not_found" || code.endsWith("_not_found"));
}

function agentStopped(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "agent_not_running" || notFound(error);
}

export function isDevinActiveScreen(screen: string): boolean {
  return (
    screen.includes("Thinking") &&
    screen.includes("Guide Devin while it works") &&
    screen.lastIndexOf("Thinking") > screen.lastIndexOf("Approve once")
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

  private async paneIsSettled(paneId: string): Promise<boolean> {
    try {
      const response = await this.client.request("pane.process_info", {
        pane_id: paneId,
      });
      const info = record(response, "process_info");
      return Array.isArray(info.foreground_processes) && (
        info.foreground_processes.length === 0 ||
        (
          typeof info.shell_pid === "number" &&
          info.foreground_process_group_id === info.shell_pid
        )
      );
    } catch (error) {
      if (notFound(error)) return true;
      throw error;
    }
  }

  private async stableAgent(
    agentName: string,
    initial: Record<string, any>,
    timeoutMs = 30_000,
  ): Promise<Record<string, any>> {
    if (typeof initial.state_change_seq !== "number") return initial;
    const deadline = Date.now() + timeoutMs;
    let observed = initial;
    let stableSince = Date.now();
    let sequence = initial.state_change_seq;
    while (true) {
      const ready =
        observed.launch_pending !== true &&
        observed.interactive_ready !== false &&
        ["idle", "working", "blocked", "done"].includes(String(observed.agent_status));
      if (ready && Date.now() - stableSince >= 750) return observed;
      if (Date.now() >= deadline) {
        throw new HerdrRuntimeInvariantError(
          `agent did not reach a stable interactive state: ${JSON.stringify(observed)}`,
        );
      }
      await delay(100);
      const response = await this.client.request("agent.get", { target: agentName });
      observed = record(response, "agent");
      if (observed.state_change_seq !== sequence) {
        sequence = observed.state_change_seq;
        stableSince = Date.now();
      }
    }
  }

  private async createSourceWorkspace(
    sourceCheckout: string,
    label: string,
  ): Promise<string> {
    const response = await this.client.request("workspace.create", {
      cwd: sourceCheckout,
      label: `harness source: ${label}:${crypto.randomUUID()}`,
      focus: false,
    });
    return String(record(response, "workspace").workspace_id);
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
    const sourceCheckout = await this.evidence.sourceCheckout(input.worktreePath);
    const sourceWorkspaceId = await this.createSourceWorkspace(
      sourceCheckout,
      input.label,
    );
    let opened: any;
    try {
      opened = await this.client.request("worktree.open", {
        path: input.worktreePath,
        workspace_id: sourceWorkspaceId,
        label: input.label,
        focus: false,
        trust_repository: true,
      });
    } catch (error) {
      await this.client.request("workspace.close", {
        workspace_id: sourceWorkspaceId,
        close_group: false,
      }).catch(() => undefined);
      throw error;
    }
    const workspace = record(opened, "workspace");
    const pane = record(opened, "root_pane");
    const workspaceId = String(workspace.workspace_id);
    return {
      workspaceId,
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
    if (!Array.isArray(processInfo.foreground_processes)) {
      throw new HerdrRuntimeInvariantError(
        `Herdr pane process information is invalid: ${JSON.stringify(processInfo)}`,
      );
    }
    const deadline = Date.now() + 30_000;
    let started: any;
    while (true) {
      try {
        started = await this.client.request("agent.start", {
          name: intent.input.agentName,
          kind: intent.input.workerKind,
          pane_id: intent.input.identity.paneId,
          args: [...intent.input.args],
          timeout_ms: 30_000,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof HerdrRemoteError) ||
          error.code !== "agent_pane_busy" ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await delay(100);
      }
    }
    const launchingAgent = record(started, "agent");
    if (
      launchingAgent.name !== intent.input.agentName ||
      launchingAgent.workspace_id !== intent.input.identity.workspaceId ||
      launchingAgent.pane_id !== intent.input.identity.paneId ||
      (
        launchingAgent.agent !== undefined &&
        launchingAgent.agent !== intent.input.workerKind
      )
    ) {
      throw new HerdrRuntimeInvariantError(
        `Herdr launched the worker in the wrong native location: ${JSON.stringify(launchingAgent)}`,
      );
    }
    if (launchingAgent.launch_pending === true || launchingAgent.agent === undefined) {
      try {
        await this.client.request("agent.wait", {
          target: intent.input.agentName,
          until: ["idle", "working", "blocked", "done"],
          timeout_ms: 30_000,
        });
      } catch (error) {
        if (!agentStopped(error)) throw error;
        return {
          agentName: intent.input.agentName,
          workerKind: intent.input.workerKind,
          workspaceId: intent.input.identity.workspaceId,
          paneId: intent.input.identity.paneId,
          worktreePath: intent.input.identity.worktreePath,
          assignedCommit: intent.input.identity.assignedCommit,
          status: "done",
        };
      }
    }
    let refreshed: any;
    try {
      refreshed = await this.client.request("agent.get", {
        target: intent.input.agentName,
      });
    } catch (error) {
      if (!agentStopped(error)) throw error;
      return {
        agentName: intent.input.agentName,
        workerKind: intent.input.workerKind,
        workspaceId: intent.input.identity.workspaceId,
        paneId: intent.input.identity.paneId,
        worktreePath: intent.input.identity.worktreePath,
        assignedCommit: intent.input.identity.assignedCommit,
        status: "done",
      };
    }
    const agent = await this.stableAgent(
      intent.input.agentName,
      record(refreshed, "agent"),
    );
    const mismatch = identityMismatchEvidence(agent, intent.input.identity);
    if (mismatch.length > 0) {
      throw new HerdrRuntimeInvariantError(
        `${mismatch.join("; ")}; observed=${JSON.stringify(agent)}`,
      );
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
    const completed = intent.input.deliveredAtLaunch === true
      ? await this.evidence.readResult(intent.input.resultPath)
      : undefined;
    if (completed !== undefined) {
      if (completed.assignmentHash !== intent.input.identity.assignmentHash) {
        throw new HerdrRuntimeInvariantError(
          "structured result assignment hash mismatch",
        );
      }
      return {
        acknowledged: true,
        assignmentHash: completed.assignmentHash,
        reconciledByResult: true,
        result: completed,
      };
    }
    let response: any;
    try {
      response = await this.client.request("agent.get", {
        target: intent.input.agentName,
      });
    } catch (error) {
      if (notFound(error)) {
        const terminal = await this.readAgentTranscript(
          intent.input.agentName,
          intent.input.identity.paneId,
        ).catch(() => "unavailable");
        let result = await this.evidence.readResult(intent.input.resultPath);
        if (
          result === undefined &&
          intent.input.resultTransport === "transcript" &&
          await this.paneIsSettled(intent.input.identity.paneId).catch(() => false)
        ) {
          result = await this.evidence.materializeTranscriptResult?.(
            intent.input.resultPath,
            terminal,
            intent.input.identity.assignmentHash,
          );
        }
        if (result !== undefined) {
          if (result.assignmentHash !== intent.input.identity.assignmentHash) {
            throw new HerdrRuntimeInvariantError(
              "structured result assignment hash mismatch",
            );
          }
          return {
            acknowledged: true,
            assignmentHash: result.assignmentHash,
            reconciledByResult: true,
            result,
          };
        }
        throw new HerdrRuntimeInvariantError(
          `assigned agent exited without a structured result; terminal=${terminal}`,
        );
      }
      throw error;
    }
    const agent = record(response, "agent");
    if (
      agent.name !== intent.input.agentName ||
      agent.pane_id !== intent.input.identity.paneId ||
      agent.workspace_id !== intent.input.identity.workspaceId ||
      (
        intent.input.deliveredAtLaunch !== true &&
        agent.agent_status !== "idle"
      )
    ) {
      throw new HerdrRuntimeInvariantError("assignment target is not the expected idle agent");
    }
    if (intent.input.deliveredAtLaunch !== true) {
      try {
        await this.client.request("agent.prompt", {
          target: intent.input.agentName,
          text: intent.input.prompt,
          wait: {
            until: ["working", "blocked"],
            timeout_ms: Math.min(intent.input.timeoutMs, 30_000),
          },
        });
      } catch (error) {
        let terminal = "unavailable";
        try {
          const response = await this.client.request("agent.read", {
            target: intent.input.agentName,
            source: "detection",
            lines: 120,
            format: "text",
          });
          terminal = String(record(response, "read").text);
        } catch {
          // Preserve the original delivery error when diagnostic collection fails.
        }
        throw new HerdrRuntimeInvariantError(
          `${error instanceof Error ? error.message : String(error)}; terminal=${terminal}`,
        );
      }
    }
    const startedAt = Date.now();
    const deadline = startedAt + intent.input.timeoutMs;
    let activityStartedAt = startedAt;
    let sawWorking = agent.agent_status === "working";
    let sawLaunchEvidence = false;
    let deliveryAttempts = 1;
    let invalidResult: string | undefined;
    while (true) {
      try {
        const result = await this.evidence.readResult(intent.input.resultPath);
        if (result !== undefined) {
          if (result.assignmentHash !== intent.input.identity.assignmentHash) {
            throw new HerdrRuntimeInvariantError(
              "structured result assignment hash mismatch",
            );
          }
          return {
            acknowledged: true,
            assignmentHash: result.assignmentHash,
            reconciledByResult: true,
            result,
          };
        }
      } catch (error) {
        invalidResult = error instanceof Error ? error.message : String(error);
      }

      let response: any;
      try {
        response = await this.client.request("agent.get", {
          target: intent.input.agentName,
        });
      } catch (error) {
        if (!notFound(error)) throw error;
        const terminal = await this.readAgentTranscript(
          intent.input.agentName,
          intent.input.identity.paneId,
        ).catch(() => "unavailable");
        if (
          intent.input.resultTransport === "transcript" &&
          await this.paneIsSettled(intent.input.identity.paneId).catch(() => false)
        ) {
          const transcriptResult = await this.evidence.materializeTranscriptResult?.(
            intent.input.resultPath,
            terminal,
            intent.input.identity.assignmentHash,
          );
          if (transcriptResult !== undefined) {
            return {
              acknowledged: true,
              assignmentHash: transcriptResult.assignmentHash,
              reconciledByResult: true,
              result: transcriptResult,
            };
          }
        }
        throw new HerdrRuntimeInvariantError(
          `worker exited before writing a structured result; terminal=${terminal}`,
        );
      }
      const current = record(response, "agent");
      const status = String(current.agent_status);
      if (status === "working") sawWorking = true;
      let settledTranscript: string | undefined;
      if (
        intent.input.resultTransport === "transcript" &&
        ["blocked", "idle", "done"].includes(status) &&
        await this.paneIsSettled(intent.input.identity.paneId)
      ) {
        settledTranscript = await this.readAgentTranscript(
          intent.input.agentName,
          intent.input.identity.paneId,
        ).catch(() => "");
        const transcriptResult = await this.evidence.materializeTranscriptResult?.(
          intent.input.resultPath,
          settledTranscript,
          intent.input.identity.assignmentHash,
        );
        if (transcriptResult !== undefined) {
          return {
            acknowledged: true,
            assignmentHash: transcriptResult.assignmentHash,
            reconciledByResult: true,
            result: transcriptResult,
          };
        }
      }
      if (status === "blocked") {
        const terminal = settledTranscript ?? await this.readAgentTranscript(
          intent.input.agentName,
          intent.input.identity.paneId,
        ).catch(() => "unavailable");
        if (
          intent.input.identity.workerKind === "devin" &&
          isDevinActiveScreen(terminal)
        ) {
          sawWorking = true;
          await delay(200);
          continue;
        }
        throw new HerdrRuntimeInvariantError(
          `worker blocked before writing a structured result${invalidResult === undefined ? "" : `: ${invalidResult}`}; terminal=${terminal}`,
        );
      }
      if (
        (sawWorking && ["idle", "done"].includes(status)) ||
        (intent.input.deliveredAtLaunch === true && status === "done")
      ) {
        const finalResult = await this.evidence.readResult(intent.input.resultPath);
        if (finalResult !== undefined) {
          if (finalResult.assignmentHash !== intent.input.identity.assignmentHash) {
            throw new HerdrRuntimeInvariantError(
              "structured result assignment hash mismatch",
            );
          }
          return {
            acknowledged: true,
            assignmentHash: finalResult.assignmentHash,
            reconciledByResult: true,
            result: finalResult,
          };
        }
        const terminal = settledTranscript ?? await this.readAgentTranscript(
          intent.input.agentName,
          intent.input.identity.paneId,
        ).catch(() => "unavailable");
        throw new HerdrRuntimeInvariantError(
          `worker settled without a structured result${invalidResult === undefined ? "" : `: ${invalidResult}`}; agent=${JSON.stringify(current)}; terminal=${terminal}`,
        );
      }
      if (
        !sawWorking &&
        !sawLaunchEvidence &&
        Date.now() - activityStartedAt >= 5_000
      ) {
        const terminal = await this.readAgentTranscript(
          intent.input.agentName,
          intent.input.identity.paneId,
        ).catch(() => "");
        const firstPromptLine = (intent.input.deliveryMarker ?? intent.input.prompt)
          .split(/\r?\n/)
          .find((line) => line.trim() !== "")
          ?.trim();
        if (
          intent.input.deliveredAtLaunch === true &&
          firstPromptLine !== undefined &&
          terminal.includes(firstPromptLine)
        ) {
          sawLaunchEvidence = true;
          await delay(200);
          continue;
        }
        if (
          intent.input.deliveredAtLaunch !== true &&
          deliveryAttempts < 2 &&
          firstPromptLine !== undefined &&
          !terminal.includes(firstPromptLine)
        ) {
          await this.client.request("agent.prompt", {
            target: intent.input.agentName,
            text: intent.input.prompt,
            wait: {
              until: ["working", "blocked"],
              timeout_ms: Math.min(intent.input.timeoutMs, 30_000),
            },
          });
          deliveryAttempts += 1;
          activityStartedAt = Date.now();
          await delay(200);
          continue;
        }
        throw new HerdrRuntimeInvariantError(
          `worker prompt produced no observed activity within 5000 ms; terminal=${terminal}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new HerdrRuntimeInvariantError(
          `worker timed out before writing a structured result${invalidResult === undefined ? "" : `: ${invalidResult}`}`,
        );
      }
      await delay(200);
    }
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
      if (intent.input.resultTransport === "transcript") {
        const settled = await this.paneIsSettled(intent.input.identity.paneId)
          .catch(() => false);
        if (settled) {
          const transcript = await this.readAgentTranscript(
            intent.input.agentName,
            intent.input.identity.paneId,
          ).catch(() => "");
          result = await this.evidence.materializeTranscriptResult?.(
            intent.input.resultPath,
            transcript,
            intent.input.identity.assignmentHash,
          );
        }
      }
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

  public async readAgentTranscript(
    agentName: string,
    paneId?: string,
    lines = 160,
  ): Promise<string> {
    try {
      const response = await this.client.request("agent.read", {
        target: agentName,
        source: "recent_unwrapped",
        lines,
        format: "text",
      });
      return String(record(response, "read").text);
    } catch (error) {
      if (paneId === undefined) throw error;
      const response = await this.client.request("pane.read", {
        pane_id: paneId,
        source: "recent_unwrapped",
        lines,
        format: "text",
      });
      return String(record(response, "read").text);
    }
  }

  public async closeWorkspace(workspaceId: string): Promise<void> {
    const existing = records(
      await this.client.request("workspace.list", {}),
      "workspaces",
    ).some((workspace) => workspace.workspace_id === workspaceId);
    if (existing) {
      await this.client.request("workspace.close", {
        workspace_id: workspaceId,
        close_group: true,
      });
    }
  }

  public async stopAgent(
    handle: WorkerHandle,
    spec: HerdrCancellationSpec,
  ): Promise<void> {
    if (spec.mode === "unavailable") {
      throw new HerdrRuntimeInvariantError("worker adapter does not support cancellation");
    }
    try {
      if (spec.gracefulKeys.length > 0) {
        await this.client.request("agent.send_keys", {
          target: handle.agentName,
          keys: [...spec.gracefulKeys],
        });
      }
      await this.client.request("agent.wait", {
        target: handle.agentName,
        until: ["idle", "done"],
        timeout_ms: spec.timeoutMs,
      });
    } catch (error) {
      if (
        !agentStopped(error) &&
        (spec.mode !== "graceful_then_force" || !spec.forcePane)
      ) throw error;
    }
    const agents = records(await this.client.request("agent.list", {}), "agents");
    const stillOwnsPane = agents.some(
      (agent) => agent.name === handle.agentName || agent.pane_id === handle.paneId,
    );
    if (!stillOwnsPane) return;
    if (spec.mode === "graceful_then_force" && spec.forcePane) {
      await this.client.request("workspace.close", {
        workspace_id: handle.workspaceId,
        close_group: true,
      });
      return;
    }
    throw new HerdrRuntimeInvariantError("stopped agent still owns its pane");
  }

  public latestAgentObservation(
    paneId: string,
  ): AgentLifecycleObservation | undefined {
    return this.events.latest(paneId);
  }
}
