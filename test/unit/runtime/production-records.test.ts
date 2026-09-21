import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  DurableRecordCollision,
  DurableRecordStore,
} from "../../../src/runtime/production/records.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

it("persists immutable attempt boundaries without putting effect keys in paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-records-"));
  temporary.push(root);
  const store = new DurableRecordStore(root);
  const value = { schemaVersion: 1, assignmentHash: `sha256:${"a".repeat(64)}` };
  await expect(store.put("worker-prepared", "worker.execute:../../escape", value))
    .resolves.toEqual(value);
  await expect(store.get("worker-prepared", "worker.execute:../../escape"))
    .resolves.toEqual(value);
  await expect(store.put("worker-prepared", "worker.execute:../../escape", value))
    .resolves.toEqual(value);
  await expect(store.put("worker-prepared", "worker.execute:../../escape", {
    ...value,
    assignmentHash: `sha256:${"b".repeat(64)}`,
  })).rejects.toBeInstanceOf(DurableRecordCollision);
});

it("returns undefined for an absent boundary and rejects unsafe record kinds", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-records-"));
  temporary.push(root);
  const store = new DurableRecordStore(root);
  await expect(store.get("worker-submitted", "missing")).resolves.toBeUndefined();
  await expect(store.put("../escape", "key", {})).rejects.toThrow(/record kind/);
});
