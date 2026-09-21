import { createConnection, type Socket } from "node:net";

export interface HerdrWireRequest {
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
}

export type HerdrTransportListener = (frame: unknown) => void;

export interface HerdrTransport {
  request(request: HerdrWireRequest): Promise<unknown>;
  subscribe(listener: HerdrTransportListener): () => void;
  close(): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class HerdrTransportError extends Error {}

export class NewlineSocketHerdrTransport implements HerdrTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<HerdrTransportListener>();
  private buffer = "";
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new HerdrTransportError("Herdr socket closed")));
  }

  public static connect(path: string): Promise<NewlineSocketHerdrTransport> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(new NewlineSocketHerdrTransport(socket));
      });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch (error) {
        this.fail(
          new HerdrTransportError(
            `invalid JSON frame: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (
        typeof frame === "object" &&
        frame !== null &&
        typeof (frame as { id?: unknown }).id === "string"
      ) {
        const id = (frame as { id: string }).id;
        const pending = this.pending.get(id);
        if (pending === undefined) {
          this.fail(new HerdrTransportError(`unexpected Herdr response id ${id}`));
          return;
        }
        this.pending.delete(id);
        pending.resolve(frame);
      } else {
        try {
          for (const listener of this.listeners) listener(frame);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.socket.destroyed) this.socket.destroy(error);
  }

  public request(request: HerdrWireRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new HerdrTransportError("transport is closed"));
    if (this.pending.has(request.id)) {
      return Promise.reject(new HerdrTransportError(`duplicate request id ${request.id}`));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.socket.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
        if (error === null || error === undefined) return;
        this.pending.delete(request.id);
        reject(error);
      });
    });
  }

  public subscribe(listener: HerdrTransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): void {
    if (!this.closed) this.fail(new HerdrTransportError("transport closed by client"));
  }
}

