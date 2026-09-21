import { execa } from "execa";
import type { ProcessRunner } from "../actions/types.js";

export class NodeProcessRunner implements ProcessRunner {
  public async run(
    executable: string,
    argv: readonly string[],
    options: Parameters<ProcessRunner["run"]>[2],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
    options: Parameters<ProcessRunner["runBytes"]>[2],
  ): Promise<{ exitCode: number; stdout: Uint8Array; stderr: string }> {
    const result = await execa(executable, [...argv], {
      reject: false,
      encoding: "buffer",
      stripFinalNewline: false,
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
