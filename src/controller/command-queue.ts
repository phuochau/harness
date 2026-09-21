export interface AcceptedCommand {
  readonly commandKey: string;
}

export interface CommandResult {
  readonly commandKey: string;
  readonly stateRevision: number;
}

export interface CommandQueueProcessor<Command> {
  accept(command: Command): Promise<AcceptedCommand>;
  processReceived(commandKey: string): Promise<CommandResult>;
  pendingCommandKeysInSequenceOrder(): Promise<readonly string[]>;
}

export class ControllerCommandQueue<Command> {
  #tail: Promise<void> = Promise.resolve();

  public constructor(private readonly processor: CommandQueueProcessor<Command>) {}

  public enqueue(command: Command): Promise<CommandResult> {
    const result = this.#tail.then(async () => {
      const accepted = await this.processor.accept(command);
      return this.processor.processReceived(accepted.commandKey);
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public recoverPending(): Promise<readonly CommandResult[]> {
    const result = this.#tail.then(async () => {
      const outputs: CommandResult[] = [];
      for (const commandKey of await this.processor.pendingCommandKeysInSequenceOrder()) {
        outputs.push(await this.processor.processReceived(commandKey));
      }
      return outputs;
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public async drain(): Promise<void> {
    await this.#tail;
  }
}
