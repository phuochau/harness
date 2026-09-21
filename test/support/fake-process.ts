import { execa } from "execa";

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly shell: false;
  readonly timeoutMs?: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ByteProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

export interface RecordedProcessCall {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly options: ProcessOptions;
  readonly mode: "text" | "bytes";
}

export interface ProcessRunnerLike {
  run(
    executable: string,
    argv: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult>;
  runBytes(
    executable: string,
    argv: readonly string[],
    options: ProcessOptions,
  ): Promise<ByteProcessResult>;
}

export class FakeProcessRunner implements ProcessRunnerLike {
  public readonly calls: RecordedProcessCall[] = [];
  private readonly textResults: ProcessResult[] = [];
  private readonly byteResults: ByteProcessResult[] = [];

  public queue(result: ProcessResult): void {
    this.textResults.push(structuredClone(result));
  }

  public queueBytes(result: ByteProcessResult): void {
    this.byteResults.push({ ...result, stdout: result.stdout.slice() });
  }

  public async run(
    executable: string,
    argv: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ executable, argv: [...argv], options, mode: "text" });
    return structuredClone(
      this.textResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" },
    );
  }

  public async runBytes(
    executable: string,
    argv: readonly string[],
    options: ProcessOptions,
  ): Promise<ByteProcessResult> {
    this.calls.push({ executable, argv: [...argv], options, mode: "bytes" });
    const result = this.byteResults.shift() ?? {
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: "",
    };
    return { ...result, stdout: result.stdout.slice() };
  }
}

export class NodeProcessRunner implements ProcessRunnerLike {
  public async run(
    executable: string,
    argv: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    const result = await execa(executable, [...argv], {
      reject: false,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stdin === undefined ? {} : { input: options.stdin }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  public async runBytes(
    executable: string,
    argv: readonly string[],
    options: ProcessOptions,
  ): Promise<ByteProcessResult> {
    const result = await execa(executable, [...argv], {
      reject: false,
      encoding: "buffer",
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stdin === undefined ? {} : { input: options.stdin }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: new Uint8Array(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  }
}
