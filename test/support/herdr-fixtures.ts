import type {
  HerdrTransport,
  HerdrTransportListener,
  HerdrWireRequest,
} from "../../src/runtime/herdr/transport.js";

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

