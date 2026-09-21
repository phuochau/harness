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

export class HerdrTransportError extends Error {}

/**
 * Herdr closes ordinary API sockets after one response. Event subscriptions
 * are the exception and keep their connection open for pushed frames. Keep
 * those lifetimes explicit instead of relying on a reusable shared socket.
 */
export class NewlineSocketHerdrTransport implements HerdrTransport {
  private readonly listeners = new Set<HerdrTransportListener>();
  private readonly sockets = new Set<Socket>();
  private readonly activeIds = new Set<string>();
  private closed = false;

  private constructor(private readonly path: string) {}

  public static async connect(path: string): Promise<NewlineSocketHerdrTransport> {
    if (path.length === 0) throw new HerdrTransportError("Herdr socket path is empty");
    return new NewlineSocketHerdrTransport(path);
  }

  private emit(frame: unknown): void {
    for (const listener of this.listeners) listener(frame);
  }

  public request(request: HerdrWireRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new HerdrTransportError("transport is closed"));
    if (this.activeIds.has(request.id)) {
      return Promise.reject(new HerdrTransportError(`duplicate request id ${request.id}`));
    }
    this.activeIds.add(request.id);
    const keepOpen = request.method === "events.subscribe";

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.path);
      this.sockets.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      let settled = false;

      const finishFailure = (error: Error): void => {
        if (!settled) {
          settled = true;
          this.activeIds.delete(request.id);
          reject(error);
        }
        this.sockets.delete(socket);
      };

      socket.on("error", (error) => finishFailure(error));
      socket.on("close", () => {
        finishFailure(new HerdrTransportError("Herdr socket closed before response"));
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch (error) {
            socket.destroy();
            finishFailure(
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
            const responseId = (frame as { id: string }).id;
            if (settled || responseId !== request.id) {
              socket.destroy();
              finishFailure(
                new HerdrTransportError(`unexpected Herdr response id ${responseId}`),
              );
              return;
            }
            settled = true;
            this.activeIds.delete(request.id);
            resolve(frame);
            if (!keepOpen) socket.end();
            continue;
          }
          try {
            this.emit(frame);
          } catch (error) {
            socket.destroy();
            finishFailure(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
      });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
          if (error === null || error === undefined) return;
          finishFailure(error);
        });
      });
    });
  }

  public subscribe(listener: HerdrTransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.activeIds.clear();
    this.listeners.clear();
  }
}
