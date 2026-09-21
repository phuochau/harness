import type { ControllerCommand } from "../contracts/controller-command.js";
import {
  ControllerCommandQueue,
  type CommandResult,
} from "./command-queue.js";

export class HarnessController {
  public constructor(
    private readonly queue: ControllerCommandQueue<ControllerCommand>,
  ) {}

  public enqueue(command: ControllerCommand): Promise<CommandResult> {
    return this.queue.enqueue(command);
  }

  public recoverPending(): Promise<readonly CommandResult[]> {
    return this.queue.recoverPending();
  }

  public drain(): Promise<void> {
    return this.queue.drain();
  }
}
