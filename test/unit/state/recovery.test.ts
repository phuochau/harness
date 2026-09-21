import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { recoverJournal } from "../../../src/state/recovery.js";
import { writeSnapshot } from "../../../src/state/snapshot.js";
import { RunLease } from "../../../src/state/lease.js";
import { persistedRunFixture } from "../../support/state-fixtures.js";

it("restores a snapshot boundary and truncates only an incomplete tail", async () => {
  const fixture = await persistedRunFixture({
    events: 4,
    snapshotAt: 2,
    tornTail: true,
  });
  try {
    const report = await recoverJournal(fixture.paths, fixture.lease);
    expect(report.repairedTail).toBe(true);
    expect(report.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(report.snapshot?.boundary.sequence).toBe(2);
    expect((await readFile(fixture.paths.events, "utf8")).endsWith("\n")).toBe(
      true,
    );
  } finally {
    await fixture.lease.release();
    await fixture.cleanup();
  }
});

it("refuses interior corruption", async () => {
  const fixture = await persistedRunFixture({ events: 4, corruptSequence: 2 });
  try {
    await expect(recoverJournal(fixture.paths, fixture.lease)).rejects.toThrow(
      /interior corruption/,
    );
  } finally {
    await fixture.lease.release();
    await fixture.cleanup();
  }
});

it("rejects snapshot and repair writes after lease takeover", async () => {
  const fixture = await persistedRunFixture({ tornTail: true });
  let current: Awaited<ReturnType<typeof RunLease.acquire>> | undefined;
  try {
    const stale = fixture.lease;
    await stale.release();
    current = await RunLease.acquire(fixture.paths, "new-owner");
    await expect(
      writeSnapshot(fixture.paths, fixture.state, fixture.boundary, stale),
    ).rejects.toThrow(/stale fencing token/);
    await expect(recoverJournal(fixture.paths, stale)).rejects.toThrow(
      /stale fencing token/,
    );
  } finally {
    await current?.release();
    await fixture.cleanup();
  }
});

it("ignores a stale snapshot and replays the verified journal from zero", async () => {
  const fixture = await persistedRunFixture({ events: 3, snapshotAt: 2 });
  try {
    const snapshot = JSON.parse(await readFile(fixture.paths.state, "utf8")) as {
      boundary: { eventHash: string };
    };
    snapshot.boundary.eventHash = `sha256:${"f".repeat(64)}`;
    await writeFile(fixture.paths.state, JSON.stringify(snapshot), "utf8");
    const report = await recoverJournal(fixture.paths, fixture.lease);
    expect(report.snapshot).toBeUndefined();
    expect(report.events).toHaveLength(3);
  } finally {
    await fixture.lease.release();
    await fixture.cleanup();
  }
});

it("accepts an empty journal and rejects interior invalid JSON", async () => {
  const empty = await persistedRunFixture({ events: 0 });
  try {
    await expect(recoverJournal(empty.paths, empty.lease)).resolves.toMatchObject({
      events: [],
      repairedTail: false,
    });
  } finally {
    await empty.lease.release();
    await empty.cleanup();
  }

  const corrupt = await persistedRunFixture({ events: 3 });
  try {
    const lines = (await readFile(corrupt.paths.events, "utf8")).split("\n");
    lines[1] = "{not-json}";
    await writeFile(corrupt.paths.events, lines.join("\n"), "utf8");
    await expect(recoverJournal(corrupt.paths, corrupt.lease)).rejects.toThrow(
      /interior corruption/,
    );
  } finally {
    await corrupt.lease.release();
    await corrupt.cleanup();
  }
});
