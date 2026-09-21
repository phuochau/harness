import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../shared/canonical-json.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { sha256 } from "../../shared/sha256.js";

export class DurableRecordCollision extends Error {}

function recordPath(root: string, kind: string, key: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) {
    throw new Error(`invalid durable record kind: ${kind}`);
  }
  return join(root, kind, `${sha256(key).slice("sha256:".length)}.json`);
}

async function readRecord(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
    throw new Error("durable record is not a bounded regular file");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

export class DurableRecordStore {
  public constructor(private readonly root: string) {}

  public async get<T>(kind: string, key: string): Promise<T | undefined> {
    const path = recordPath(this.root, kind, key);
    try {
      return deepFreeze(await readRecord(path)) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async put<T>(kind: string, key: string, value: T): Promise<T> {
    const path = recordPath(this.root, kind, key);
    const serialized = canonicalJson(value);
    const prior = await this.get<T>(kind, key);
    if (prior !== undefined) {
      if (canonicalJson(prior) !== serialized) {
        throw new DurableRecordCollision(`durable ${kind} record changed for ${key}`);
      }
      return prior;
    }
    await mkdir(join(this.root, kind), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${serialized}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      const directory = await open(join(this.root, kind), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return deepFreeze(structuredClone(value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.get<T>(kind, key);
      if (existing === undefined || canonicalJson(existing) !== serialized) {
        throw new DurableRecordCollision(`durable ${kind} record changed for ${key}`);
      }
      return existing;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
