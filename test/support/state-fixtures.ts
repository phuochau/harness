import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../../src/contracts/common.js";
import type { HarnessEvent } from "../../src/contracts/events.js";
import { Journal, type EventInput } from "../../src/state/journal.js";
import { RunLease, type LeaseHandle } from "../../src/state/lease.js";
import { resolveRunPaths } from "../../src/state/paths.js";
import {
  writeSnapshot,
  type EventBoundary,
} from "../../src/state/snapshot.js";
import type { RunPaths } from "../../src/state/types.js";
import type { DeepPartial } from "./fixture.js";
import { deepMerge } from "./fixture.js";
import { fixtureState, type FixtureState } from "./factories.js";
import { createTempRepo } from "./temp-repo.js";

export interface TempRepoWithWorktree {
  readonly repository: string;
  readonly worktree: string;
  readonly commonDir: string;
  cleanup(): Promise<void>;
}

export async function createTempRepoWithWorktree(): Promise<TempRepoWithWorktree> {
  const repo = await createTempRepo();
  const worktreeParent = await mkdtemp(join(tmpdir(), "pi-harness-linked-"));
  const worktree = join(worktreeParent, "worktree");
  const add = await repo.process.run(
    "git",
    ["worktree", "add", "-b", "fixture-linked", worktree],
    { cwd: repo.path, shell: false },
  );
  if (add.exitCode !== 0) {
    await rm(worktreeParent, { recursive: true, force: true });
    await rm(repo.path, { recursive: true, force: true });
    throw new Error(add.stderr);
  }
  const common = await repo.process.run(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: worktree, shell: false },
  );
  if (common.exitCode !== 0) throw new Error(common.stderr);
  const commonDir = common.stdout.trim();
  return {
    repository: repo.path,
    worktree,
    commonDir,
    cleanup: async () => {
      await repo.process.run("git", ["worktree", "remove", "--force", worktree], {
        cwd: repo.path,
        shell: false,
      });
      await rm(worktreeParent, { recursive: true, force: true });
      await rm(repo.path, { recursive: true, force: true });
    },
  };
}

const hashA = `sha256:${"a".repeat(64)}` as const;

function payloadFor(eventType: HarnessEvent["eventType"]): JsonValue {
  if (eventType === "effect.intent") {
    return {
      action: "worker.start",
      idempotencyKey: "launch:T001:1",
      recovery: "reconcilable",
      laneKey: "worker:T001",
      input: {},
    };
  }
  if (eventType === "run.created") return { workflowRevision: hashA };
  return {};
}

export function fixtureEventInput(
  overrides: DeepPartial<EventInput> = {},
): EventInput {
  const eventType = (overrides.eventType ?? "job.ready") as HarnessEvent["eventType"];
  const base: EventInput = {
    schemaVersion: 1,
    timestamp: "2026-09-20T00:00:00.000Z",
    runId: "F023",
    entityId: "job:implement:T001",
    idempotencyKey: "ready:T001",
    eventType,
    payload: payloadFor(eventType),
  };
  return deepMerge(base, overrides);
}

export interface JournalFixture {
  readonly paths: RunPaths;
  readonly journal: Journal;
  readonly lease: LeaseHandle;
  cleanup(): Promise<void>;
}

export async function journalFixture(): Promise<JournalFixture> {
  const repo = await createTempRepoWithWorktree();
  const paths = await resolveRunPaths(repo.worktree, "F023");
  const lease = await RunLease.acquire(paths, "controller-a");
  return {
    paths,
    journal: new Journal(paths),
    lease,
    cleanup: repo.cleanup,
  };
}

export interface PersistedRunOptions {
  readonly events?: number;
  readonly snapshotAt?: number;
  readonly tornTail?: boolean;
  readonly corruptSequence?: number;
}

export interface PersistedRunFixture extends JournalFixture {
  readonly state: FixtureState;
  readonly boundary: EventBoundary;
}

export async function persistedRunFixture(
  options: PersistedRunOptions = {},
): Promise<PersistedRunFixture> {
  const fixture = await journalFixture();
  const eventCount = options.events ?? 2;
  const events: HarnessEvent[] = [];
  for (let index = 0; index < eventCount; index += 1) {
    const result = await fixture.journal.append(
      fixtureEventInput({
        idempotencyKey: `event:${index + 1}`,
        entityId: `job:${index + 1}`,
      }),
      fixture.lease,
    );
    events.push(result.event);
  }
  const snapshotAt = Math.min(options.snapshotAt ?? 0, events.length);
  const boundary: EventBoundary =
    snapshotAt === 0
      ? {
          sequence: 0,
          eventHash: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
        }
      : {
          sequence: snapshotAt,
          eventHash: events[snapshotAt - 1]!.eventHash as `sha256:${string}`,
        };
  const state = fixtureState({
    sequence: boundary.sequence,
    eventHash: boundary.eventHash,
  });
  if (options.snapshotAt !== undefined) {
    await writeSnapshot(fixture.paths, state, boundary, fixture.lease);
  }
  if (options.corruptSequence !== undefined) {
    const lines = (await readFile(fixture.paths.events, "utf8"))
      .trimEnd()
      .split("\n");
    const target = options.corruptSequence - 1;
    const event = JSON.parse(lines[target]!) as Record<string, unknown>;
    event.sequence = 999;
    lines[target] = JSON.stringify(event);
    await writeFile(fixture.paths.events, `${lines.join("\n")}\n`, "utf8");
  }
  if (options.tornTail) {
    await appendFile(fixture.paths.events, '{"partial":', "utf8");
  }
  return { ...fixture, state, boundary };
}
