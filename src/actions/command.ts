import type {
  ActionContext,
  ActionHandler,
  EffectIntent,
  ReconcileResult,
  RecoveryClass,
} from "./types.js";

export interface CommandInput {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly probe?: readonly string[];
  readonly expectedCommit?: string;
  readonly timeoutMs?: number;
}

export interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly commit?: string;
}

export class CommandInvariantError extends Error {}

function assertCommand(argv: readonly string[], label: string): void {
  if (argv.length === 0 || argv[0] === undefined || argv[0] === "") {
    throw new CommandInvariantError(`${label} argv must name an executable`);
  }
}

async function assertPinned(
  context: ActionContext,
  input: CommandInput,
): Promise<void> {
  if (input.expectedCommit !== undefined && input.cwd === undefined) {
    throw new CommandInvariantError("expectedCommit requires cwd");
  }
  if (input.expectedCommit !== undefined && input.cwd !== undefined) {
    try {
      await context.git.assertWorktreeCommit(input.cwd, input.expectedCommit);
    } catch (error) {
      throw new CommandInvariantError(
        `verification worktree commit mismatch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function processOptions(input: CommandInput): {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly timeoutMs?: number;
} {
  return {
    shell: false,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

export class CommandAction
  implements ActionHandler<"command.run", CommandInput, CommandOutput>
{
  public readonly kind = "command.run" as const;

  public recovery(input: CommandInput): RecoveryClass {
    return input.probe === undefined ? "non_retryable" : "reconcilable";
  }

  public async execute(
    context: ActionContext,
    intent: EffectIntent<"command.run", CommandInput>,
  ): Promise<CommandOutput> {
    assertCommand(intent.input.argv, "command");
    await assertPinned(context, intent.input);
    return context.process.run(
      intent.input.argv[0]!,
      intent.input.argv.slice(1),
      processOptions(intent.input),
    );
  }

  public async reconcile(
    context: ActionContext,
    intent: EffectIntent<"command.run", CommandInput>,
  ): Promise<ReconcileResult<CommandOutput>> {
    const { probe } = intent.input;
    if (probe === undefined) {
      return {
        status: "indeterminate",
        evidence: ["command has no reconciliation probe"],
      };
    }
    assertCommand(probe, "probe");
    await assertPinned(context, intent.input);
    const result = await context.process.run(
      probe[0]!,
      probe.slice(1),
      processOptions(intent.input),
    );
    return result.exitCode === 0
      ? { status: "observed", output: result }
      : { status: "not_found" };
  }
}
