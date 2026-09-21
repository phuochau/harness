import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { LeaseRecord, RunPaths } from "./types.js";

async function readLeaseRecord(path: string): Promise<LeaseRecord> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LeaseRecord>;
  if (
    typeof parsed.ownerId !== "string" ||
    !Number.isInteger(parsed.fencingToken) ||
    (parsed.fencingToken ?? 0) < 1 ||
    typeof parsed.acquiredAt !== "string"
  ) {
    throw new Error("invalid lease record");
  }
  return parsed as LeaseRecord;
}

async function readPreviousToken(path: string): Promise<number> {
  try {
    return (await readLeaseRecord(path)).fencingToken;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function atomicJson(
  path: string,
  value: LeaseRecord,
  mode: number,
): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const file = await open(temporary, "wx", mode);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, mode);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class LeaseHandle {
  public readonly ownerId: string;
  public readonly fencingToken: number;
  private released = false;

  public constructor(
    private readonly paths: RunPaths,
    record: LeaseRecord,
  ) {
    this.ownerId = record.ownerId;
    this.fencingToken = record.fencingToken;
  }

  public async assertCurrent(): Promise<void> {
    const record = await readLeaseRecord(this.paths.lease);
    if (
      this.released ||
      record.ownerId !== this.ownerId ||
      record.fencingToken !== this.fencingToken
    ) {
      throw new Error(
        `stale fencing token ${this.fencingToken} for ${this.ownerId}`,
      );
    }
  }

  public async release(): Promise<void> {
    if (this.released) return;
    await this.assertCurrent();
    this.released = true;
    await rmdir(this.paths.lockDir);
  }
}

export class RunLease {
  public static async acquire(
    paths: RunPaths,
    ownerId: string,
  ): Promise<LeaseHandle> {
    if (ownerId.length === 0) throw new Error("lease owner ID is required");
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    try {
      await mkdir(paths.lockDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`run lease held at ${paths.lockDir}`);
      }
      throw error;
    }
    try {
      const previousToken = await readPreviousToken(paths.lease);
      const record: LeaseRecord = {
        ownerId,
        fencingToken: previousToken + 1,
        acquiredAt: new Date().toISOString(),
      };
      await atomicJson(paths.lease, record, 0o600);
      return new LeaseHandle(paths, record);
    } catch (error) {
      await rmdir(paths.lockDir).catch(() => undefined);
      throw error;
    }
  }
}
