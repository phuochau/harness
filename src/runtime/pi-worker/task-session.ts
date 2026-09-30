import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

export interface TaskSessionStoreOptions {
  readonly root: string;
  readonly maxTranscriptBytes?: number;
}

export interface TaskSessionDescriptor {
  readonly taskId: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly transcriptPath?: string;
}

export type TaskSessionBlockReason =
  | "session_missing"
  | "session_corrupt"
  | "transcript_missing"
  | "transcript_corrupt"
  | "transcript_oversize"
  | "writer_active";

export type TaskSessionCheck =
  | { readonly status: "ok"; readonly session: TaskSessionDescriptor }
  | {
      readonly status: "blocked";
      readonly reason: TaskSessionBlockReason;
      readonly detail: string;
      readonly session?: TaskSessionDescriptor;
    };

export interface TaskSessionWriter {
  readonly taskId: string;
  readonly owner: string;
  release(): Promise<void>;
}

export type TaskSessionAcquisition =
  | { readonly status: "acquired"; readonly writer: TaskSessionWriter }
  | {
      readonly status: "blocked";
      readonly reason: TaskSessionBlockReason;
      readonly detail: string;
    };

export type TaskSessionResume =
  | {
      readonly status: "resumable";
      readonly session: TaskSessionDescriptor;
      readonly writer: TaskSessionWriter;
    }
  | {
      readonly status: "blocked";
      readonly reason: TaskSessionBlockReason;
      readonly detail: string;
    };

interface TaskSessionRecord {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const RECORD_FILE = "session.json";
const WRITER_LOCK = "writer.lock";

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function blocked(
  reason: TaskSessionBlockReason,
  detail: string,
  session?: TaskSessionDescriptor,
): TaskSessionCheck {
  return { status: "blocked", reason, detail, ...(session === undefined ? {} : { session }) };
}

export class TaskSessionStore {
  private readonly maxTranscriptBytes: number;

  public constructor(private readonly options: TaskSessionStoreOptions) {
    this.maxTranscriptBytes = options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  }

  private taskDir(taskId: string): string {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new Error(`invalid task session identifier: ${taskId}`);
    }
    return join(this.options.root, taskId);
  }

  private async readRecord(dir: string, taskId: string): Promise<TaskSessionRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(dir, RECORD_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let record: TaskSessionRecord;
    try {
      record = JSON.parse(raw) as TaskSessionRecord;
    } catch {
      return undefined;
    }
    if (
      record.schemaVersion !== 1 ||
      record.taskId !== taskId ||
      typeof record.sessionId !== "string" ||
      !SESSION_ID_PATTERN.test(record.sessionId)
    ) {
      return undefined;
    }
    return record;
  }

  public async create(input: {
    readonly taskId: string;
    readonly sessionId?: string;
  }): Promise<TaskSessionDescriptor> {
    const dir = this.taskDir(input.taskId);
    const sessionId = input.sessionId ?? randomUUID();
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`invalid Pi session id: ${sessionId}`);
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirInfo = await lstat(dir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error("task session directory is not a real directory");
    }
    const record: TaskSessionRecord = {
      schemaVersion: 1,
      taskId: input.taskId,
      sessionId,
      createdAt: new Date().toISOString(),
    };
    try {
      await writeFile(join(dir, RECORD_FILE), `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return { taskId: input.taskId, sessionId, sessionDir: dir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await this.readRecord(dir, input.taskId);
    if (existing === undefined) {
      throw new Error(`task session directory already exists without a valid record: ${input.taskId}`);
    }
    if (input.sessionId !== undefined && existing.sessionId !== input.sessionId) {
      throw new Error(
        `task session already registered under a different session id: ${input.taskId}`,
      );
    }
    return { taskId: existing.taskId, sessionId: existing.sessionId, sessionDir: dir };
  }

  public async verify(taskId: string): Promise<TaskSessionCheck> {
    const dir = this.taskDir(taskId);
    const dirInfo = await lstatOrNull(dir);
    if (dirInfo === null) {
      return blocked("session_missing", `task session directory does not exist: ${taskId}`);
    }
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      return blocked("session_corrupt", "task session path is not a real directory");
    }
    if ((dirInfo.mode & 0o077) !== 0) {
      return blocked("session_corrupt", "task session directory is not private");
    }
    const [rootReal, dirReal] = await Promise.all([
      realpath(this.options.root).catch(() => undefined),
      realpath(dir).catch(() => undefined),
    ]);
    if (rootReal === undefined || dirReal === undefined || !dirReal.startsWith(`${rootReal}${sep}`)) {
      return blocked("session_corrupt", "task session directory escapes the managed session root");
    }

    const recordPath = join(dir, RECORD_FILE);
    const recordInfo = await lstatOrNull(recordPath);
    if (recordInfo === null || recordInfo.isSymbolicLink() || !recordInfo.isFile()) {
      return blocked("session_corrupt", "task session record is missing or not a regular file");
    }
    if ((recordInfo.mode & 0o077) !== 0) {
      return blocked("session_corrupt", "task session record is not private");
    }
    const record = await this.readRecord(dir, taskId);
    if (record === undefined) {
      return blocked("session_corrupt", "task session record is unreadable or mismatched");
    }
    const session: TaskSessionDescriptor = {
      taskId,
      sessionId: record.sessionId,
      sessionDir: dir,
    };

    const suffix = `_${record.sessionId}.jsonl`;
    const candidates = (await readdir(dir)).filter((entry) => entry.endsWith(suffix));
    if (candidates.length === 0) {
      return blocked("transcript_missing", "task session transcript was not written", session);
    }
    if (candidates.length > 1) {
      return blocked("transcript_corrupt", "task session has multiple transcripts", session);
    }
    const transcriptPath = join(dir, candidates[0]!);
    const located: TaskSessionDescriptor = { ...session, transcriptPath };
    const transcriptInfo = await lstatOrNull(transcriptPath);
    if (transcriptInfo === null) {
      return blocked("transcript_missing", "task session transcript was removed", located);
    }
    if (transcriptInfo.isSymbolicLink() || !transcriptInfo.isFile()) {
      return blocked("transcript_corrupt", "task session transcript is not a regular file", located);
    }
    if (transcriptInfo.size > this.maxTranscriptBytes) {
      return blocked(
        "transcript_oversize",
        `task session transcript exceeds ${this.maxTranscriptBytes} bytes`,
        located,
      );
    }
    const raw = await readFile(transcriptPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    let header: unknown;
    try {
      for (const line of lines) JSON.parse(line);
      header = JSON.parse(lines[0] ?? "null");
    } catch {
      return blocked("transcript_corrupt", "task session transcript is not valid JSONL", located);
    }
    if (
      typeof header !== "object" || header === null ||
      (header as { type?: unknown }).type !== "session" ||
      (header as { id?: unknown }).id !== record.sessionId
    ) {
      return blocked(
        "transcript_corrupt",
        "task session transcript header does not match the recorded session",
        located,
      );
    }
    return { status: "ok", session: located };
  }

  public async acquireWriter(taskId: string, owner: string): Promise<TaskSessionAcquisition> {
    const dir = this.taskDir(taskId);
    if (owner === "") throw new Error("task session writer requires an owner");
    const dirInfo = await lstatOrNull(dir);
    if (dirInfo === null) {
      return { status: "blocked", reason: "session_missing", detail: `task session does not exist: ${taskId}` };
    }
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      return { status: "blocked", reason: "session_corrupt", detail: "task session path is not a real directory" };
    }
    const lockPath = join(dir, WRITER_LOCK);
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({ owner, acquiredAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = "unknown";
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as { owner?: unknown };
        if (typeof current.owner === "string") holder = current.owner;
      } catch {
        // An unreadable lock still fences the transcript.
      }
      return {
        status: "blocked",
        reason: "writer_active",
        detail: `task session transcript already has an active writer: ${holder}`,
      };
    }
    const writer: TaskSessionWriter = {
      taskId,
      owner,
      release: async () => {
        let current: { owner?: unknown };
        try {
          current = JSON.parse(await readFile(lockPath, "utf8")) as { owner?: unknown };
        } catch {
          return;
        }
        if (current.owner !== owner) return;
        await rm(lockPath, { force: true });
      },
    };
    return { status: "acquired", writer };
  }

  public async resume(taskId: string, owner: string): Promise<TaskSessionResume> {
    const check = await this.verify(taskId);
    if (check.status === "blocked") {
      return { status: "blocked", reason: check.reason, detail: check.detail };
    }
    const acquisition = await this.acquireWriter(taskId, owner);
    if (acquisition.status === "blocked") return acquisition;
    return { status: "resumable", session: check.session, writer: acquisition.writer };
  }
}
