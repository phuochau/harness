import { readFile, writeFile } from "node:fs/promises";
import fc from "fast-check";
import { expect, it } from "vitest";
import { RunLease } from "../../../src/state/lease.js";
import { readAndVerifyJournal } from "../../../src/state/hash-chain.js";
import {
  fixtureEventInput,
  journalFixture,
} from "../../support/state-fixtures.js";

it("deduplicates identical appends and rejects key reuse", async () => {
  const fixture = await journalFixture();
  try {
    const input = fixtureEventInput({
      eventType: "effect.intent",
      idempotencyKey: "launch:T001:1",
    });
    const first = await fixture.journal.append(input, fixture.lease);
    const second = await fixture.journal.append(input, fixture.lease);
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ event: first.event, inserted: false });
    await expect(
      fixture.journal.append(
        { ...input, payload: { changed: true } },
        fixture.lease,
      ),
    ).rejects.toThrow(/idempotency collision/);
  } finally {
    await fixture.cleanup();
  }
});

it("rejects a stale fencing token", async () => {
  const fixture = await journalFixture();
  let current: Awaited<ReturnType<typeof RunLease.acquire>> | undefined;
  try {
    const stale = fixture.lease;
    await stale.release();
    current = await RunLease.acquire(fixture.paths, "new-owner");
    await expect(
      fixture.journal.append(fixtureEventInput(), stale),
    ).rejects.toThrow(/stale fencing token/);
  } finally {
    await current?.release();
    await fixture.cleanup();
  }
});

it("preserves sequence and hash stability across reopen", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
        minLength: 1,
        maxLength: 20,
      }),
      async (keys) => {
        const fixture = await journalFixture();
        try {
          for (const [index, key] of keys.entries()) {
            await fixture.journal.append(
              fixtureEventInput({
                idempotencyKey: `${index}:${key}`,
                entityId: `job:${index}`,
              }),
              fixture.lease,
            );
          }
          const events = await readAndVerifyJournal(fixture.paths.events);
          expect(events.map((event) => event.sequence)).toEqual(
            keys.map((_, index) => index + 1),
          );
        } finally {
          await fixture.lease.release();
          await fixture.cleanup();
        }
      },
    ),
    { numRuns: 8 },
  );
});

it("rejects a mutated interior record", async () => {
  const fixture = await journalFixture();
  try {
    await fixture.journal.append(
      fixtureEventInput({ idempotencyKey: "first" }),
      fixture.lease,
    );
    await fixture.journal.append(
      fixtureEventInput({ idempotencyKey: "second", entityId: "job:second" }),
      fixture.lease,
    );
    const lines = (await readFile(fixture.paths.events, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    first.entityId = "tampered";
    lines[0] = JSON.stringify(first);
    await writeFile(fixture.paths.events, `${lines.join("\n")}\n`, "utf8");
    await expect(readAndVerifyJournal(fixture.paths.events)).rejects.toThrow(
      /hash chain/,
    );
  } finally {
    await fixture.lease.release();
    await fixture.cleanup();
  }
});
