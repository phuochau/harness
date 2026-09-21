import type { ActionHandler } from "./types.js";

type ErasedActionHandler = ActionHandler<string, never, unknown>;

export class ActionRegistry {
  readonly #handlers = new Map<string, ErasedActionHandler>();

  public register<K extends string, I, O>(
    handler: ActionHandler<K, I, O>,
  ): void {
    if (this.#handlers.has(handler.kind)) {
      throw new Error(`duplicate action ${handler.kind}`);
    }
    this.#handlers.set(handler.kind, handler as ErasedActionHandler);
  }

  public get<K extends string, I, O>(kind: K): ActionHandler<K, I, O> {
    const handler = this.#handlers.get(kind);
    if (!handler) throw new Error(`unknown action ${kind}`);
    return handler as ActionHandler<K, I, O>;
  }
}
