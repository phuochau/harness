import { realpath } from "node:fs/promises";
import type { ControllerCommand } from "../contracts/controller-command.js";
import type { CommandResult } from "../controller/command-queue.js";

export interface ActiveRun {
  readonly repositoryRoot: string;
  readonly runId: string;
}

export interface ResidentController {
  enqueue(command: ControllerCommand): Promise<CommandResult | unknown>;
}

export interface ResidentControllerFactory {
  recover(run: ActiveRun): Promise<ResidentController>;
}

export class ControllerRegistry {
  readonly #controllers = new Map<string, Promise<ResidentController>>();

  public constructor(private readonly factory: ResidentControllerFactory) {}

  public async getOrRecover(run: ActiveRun): Promise<ResidentController> {
    const root = await realpath(run.repositoryRoot);
    const key = `${root}\0${run.runId}`;
    const existing = this.#controllers.get(key);
    if (existing !== undefined) return existing;
    const recovering = this.factory.recover({ ...run, repositoryRoot: root });
    this.#controllers.set(key, recovering);
    try {
      return await recovering;
    } catch (error) {
      if (this.#controllers.get(key) === recovering) this.#controllers.delete(key);
      throw error;
    }
  }

  public async forget(run: ActiveRun): Promise<void> {
    const root = await realpath(run.repositoryRoot);
    this.#controllers.delete(`${root}\0${run.runId}`);
  }
}
