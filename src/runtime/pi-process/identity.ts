import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { sha256 } from "../../shared/sha256.js";
import type { PiProcessRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export interface LiveProcessIdentity {
  readonly pid: number;
  readonly startIdentity: string;
  readonly executable: string;
  readonly attemptToken: string;
  readonly stopped?: boolean;
}

export interface ProcessIdentityPort {
  capture(
    pid: number,
    executable: string,
    attemptToken: string,
  ): Promise<LiveProcessIdentity>;
  inspect(record: PiProcessRecord): Promise<LiveProcessIdentity | undefined>;
}

export function identityMismatchEvidence(
  observed: LiveProcessIdentity,
  record: PiProcessRecord,
): readonly string[] {
  const evidence: string[] = [];
  if (observed.pid !== record.pid) evidence.push("pid mismatch");
  if (observed.startIdentity !== record.startIdentity) {
    evidence.push("start identity mismatch");
  }
  if (observed.executable !== record.executable) evidence.push("executable mismatch");
  if (observed.attemptToken !== record.attemptToken) {
    evidence.push("attempt token mismatch");
  }
  return evidence;
}

async function normalizedExecutable(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function linuxIdentity(pid: number): Promise<{ start: string; executable: string; stopped: boolean }> {
  const [stat, executable] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    realpath(`/proc/${pid}/exe`),
  ]);
  const closingParenthesis = stat.lastIndexOf(")");
  const fields = stat.slice(closingParenthesis + 2).split(" ");
  const startTime = fields[19];
  if (closingParenthesis < 0 || startTime === undefined) {
    throw new Error(`cannot derive process start identity for pid ${pid}`);
  }
  return { start: startTime, executable, stopped: fields[0] === "T" || fields[0] === "t" };
}

async function darwinIdentity(pid: number): Promise<{ start: string; executable: string; stopped: boolean }> {
  const [{ stdout: start }, { stdout: executable }, { stdout: state }] = await Promise.all([
    execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
    execFileAsync("/bin/ps", ["-p", String(pid), "-o", "comm="]),
    execFileAsync("/bin/ps", ["-p", String(pid), "-o", "state="]),
  ]);
  const marker = start.trim();
  const command = executable.trim();
  if (marker === "" || command === "") throw new Error(`process ${pid} is missing`);
  return {
    start: marker,
    executable: await normalizedExecutable(command),
    stopped: state.trim().startsWith("T"),
  };
}

async function liveIdentity(pid: number): Promise<{ start: string; executable: string; stopped: boolean }> {
  if (process.platform === "linux") return linuxIdentity(pid);
  if (process.platform === "darwin") return darwinIdentity(pid);
  throw new Error(`unsupported process identity platform: ${process.platform}`);
}

function computeStartIdentity(
  pid: number,
  start: string,
  executable: string,
  attemptToken: string,
): string {
  return sha256(`${pid}\0${start}\0${executable}\0${attemptToken}`);
}

export class SystemProcessIdentity implements ProcessIdentityPort {
  public async capture(
    pid: number,
    executable: string,
    attemptToken: string,
  ): Promise<LiveProcessIdentity> {
    const observed = await liveIdentity(pid);
    const expectedExecutable = await normalizedExecutable(executable);
    if (observed.executable !== expectedExecutable) {
      throw new Error(
        `spawned executable mismatch: expected ${expectedExecutable}, observed ${observed.executable}`,
      );
    }
    return {
      pid,
      executable: observed.executable,
      attemptToken,
      stopped: observed.stopped,
      startIdentity: computeStartIdentity(pid, observed.start, observed.executable, attemptToken),
    };
  }

  public async inspect(record: PiProcessRecord): Promise<LiveProcessIdentity | undefined> {
    try {
      const observed = await liveIdentity(record.pid);
      return {
        pid: record.pid,
        executable: observed.executable,
        attemptToken: record.attemptToken,
        stopped: observed.stopped,
        startIdentity: computeStartIdentity(
          record.pid,
          observed.start,
          observed.executable,
          record.attemptToken,
        ),
      };
    } catch (error) {
      const code: unknown = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH" || code === "EINVAL" || code === 1) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/process .* is missing|No such process/i.test(message)) return undefined;
      throw error;
    }
  }
}
