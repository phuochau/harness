import type {
  HerdrTransport,
  HerdrTransportListener,
  HerdrWireRequest,
} from "../../src/runtime/herdr/transport.js";
import type {
  HerdrControlClient,
  RuntimeEvidence,
} from "../../src/runtime/herdr/runtime.js";
import type { HerdrEvent } from "../../src/runtime/herdr/client.js";
import type { WorkerResult } from "../../src/contracts/worker-result.js";

export class FakeHerdrTransport implements HerdrTransport {
  public readonly requests: HerdrWireRequest[] = [];
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly listeners = new Set<HerdrTransportListener>();

  public request(request: HerdrWireRequest): Promise<unknown> {
    this.requests.push(structuredClone(request));
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
    });
  }

  public subscribe(listener: HerdrTransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public receive(frame: unknown): void {
    if (
      typeof frame === "object" &&
      frame !== null &&
      typeof (frame as { id?: unknown }).id === "string"
    ) {
      const id = (frame as { id: string }).id;
      const pending = this.pending.get(id);
      if (!pending) throw new Error(`unexpected response id ${id}`);
      this.pending.delete(id);
      pending.resolve(frame);
      return;
    }
    for (const listener of this.listeners) listener(frame);
  }

  public close(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("transport closed"));
    }
    this.pending.clear();
  }
}

export function workspaceListResponse(id: string, workspaces: readonly unknown[]) {
  return {
    id,
    result: { type: "workspace_list", workspaces: [...workspaces] },
  };
}

export interface FakeHerdrClientOptions {
  readonly worktreePath?: string;
  readonly commit?: string;
  readonly existingAgent?: Readonly<Record<string, unknown>>;
  readonly result?: WorkerResult;
  readonly promptConnectionLost?: boolean;
  readonly missingPane?: boolean;
  readonly foregroundBusy?: boolean;
}

export class FakeHerdrClient implements HerdrControlClient {
  public readonly requestLog: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(event: HerdrEvent) => void>();
  private readonly worktreePath: string;
  private agent: Readonly<Record<string, unknown>> | undefined;

  public constructor(private readonly options: FakeHerdrClientOptions = {}) {
    this.worktreePath = options.worktreePath ?? "/repo task worktree";
    this.agent = options.existingAgent;
  }

  public calls(method: string) {
    return this.requestLog.filter((call) => call.method === method);
  }

  public async request(method: string, params: Readonly<Record<string, unknown>>): Promise<any> {
    this.requestLog.push({ method, params: structuredClone(params) });
    switch (method) {
      case "workspace.list":
        return {
          type: "workspace_list",
          workspaces: [
            {
              workspace_id: "w1",
              worktree: {
                checkout_path: this.worktreePath,
                repo_key: "repo",
                repo_name: "repo",
                repo_root: "/repo",
                is_linked_worktree: true,
              },
            },
          ],
        };
      case "pane.list":
        return {
          type: "pane_list",
          panes: this.options.missingPane ? [] : [
            {
              pane_id: "w1:p1",
              workspace_id: "w1",
              agent_status: this.agent?.agent_status ?? "idle",
              agent: this.agent?.agent ?? null,
            },
          ],
        };
      case "pane.get":
        if (this.options.missingPane) {
          throw Object.assign(new Error("pane not found"), { code: "not_found" });
        }
        return {
          type: "pane_info",
          pane: {
            pane_id: "w1:p1",
            workspace_id: "w1",
            agent_status: this.agent?.agent_status ?? "idle",
            agent: this.agent?.agent ?? null,
          },
        };
      case "pane.process_info":
        return {
          type: "pane_process_info",
          process_info: {
            pane_id: "w1:p1",
            shell_pid: 123,
            foreground_process_group_id: null,
            foreground_processes: this.options.foregroundBusy
              ? [{ pid: 999, command: "other" }]
              : [],
          },
        };
      case "agent.list":
        return { type: "agent_list", agents: this.agent ? [this.agent] : [] };
      case "agent.get":
        if (!this.agent) throw Object.assign(new Error("not found"), { code: "not_found" });
        return { type: "agent_info", agent: this.agent };
      case "agent.start":
        this.agent = {
          name: params.name,
          agent: params.kind,
          pane_id: params.pane_id,
          workspace_id: "w1",
          agent_status: "idle",
        };
        return { type: "agent_started", agent: this.agent, argv: params.args ?? [] };
      case "agent.prompt":
        if (this.options.promptConnectionLost) throw new Error("connection lost");
        return { type: "agent_prompted", agent: this.agent };
      case "agent.send_keys":
        this.agent = undefined;
        return { type: "keys_sent" };
      case "agent.wait":
        return { type: "agent_wait", agent: this.agent };
      case "worktree.open":
        return {
          type: "worktree_opened",
          already_open: false,
          workspace: { workspace_id: "w1" },
          root_pane: { pane_id: "w1:p1", workspace_id: "w1" },
          tab: { tab_id: "w1:t1" },
          worktree: { path: this.worktreePath },
        };
      default:
        throw new Error(`unhandled fake Herdr method ${method}`);
    }
  }

  public subscribe(listener: (event: HerdrEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(event: HerdrEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function fakeRuntimeEvidence(options: FakeHerdrClientOptions = {}): RuntimeEvidence {
  return {
    worktreeCommit: async () => options.commit ?? "abc123",
    readResult: async () => options.result,
  };
}
