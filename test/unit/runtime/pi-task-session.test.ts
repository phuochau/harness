import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { TaskSessionStore } from "../../../src/runtime/pi-worker/task-session.js";
import { resolveRunPaths } from "../../../src/state/paths.js";
import { createTempRepoWithWorktree } from "../../support/state-fixtures.js";

const temporary: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-task-session-"));
  temporary.push(root);
  return root;
}

async function writeTranscript(
  dir: string,
  sessionId: string,
  extra = "",
): Promise<string> {
  const path = join(dir, `2026-09-30T00-00-00-000Z_${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-09-30T00:00:00.000Z",
    cwd: "/attempt/worktree",
  };
  const message = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-09-30T00:00:01.000Z",
    message: { role: "user", content: "implement the task" },
  };
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${extra}`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("TaskSessionStore", () => {
  it("creates a private task-scoped session inside the managed run root", async () => {
    const repo = await createTempRepoWithWorktree();
    try {
      const paths = await resolveRunPaths(repo.worktree, "F090");
      const store = new TaskSessionStore({ root: paths.sessions });

      const session = await store.create({ taskId: "T1" });
      expect(session.taskId).toBe("T1");
      expect(session.sessionId).not.toBe("");
      expect(session.sessionDir).toBe(join(paths.sessions, "T1"));
      expect(session.sessionDir.startsWith(`${paths.root}/`)).toBe(true);

      const dirInfo = await stat(session.sessionDir);
      expect(dirInfo.isDirectory()).toBe(true);
      expect(dirInfo.mode & 0o777).toBe(0o700);

      const record = JSON.parse(await readFile(join(session.sessionDir, "session.json"), "utf8"));
      expect(record).toMatchObject({ taskId: "T1", sessionId: session.sessionId });
      const recordInfo = await lstat(join(session.sessionDir, "session.json"));
      expect(recordInfo.isSymbolicLink()).toBe(false);
      expect(recordInfo.mode & 0o777).toBe(0o600);

      const again = await store.create({ taskId: "T1" });
      expect(again.sessionId).toBe(session.sessionId);
    } finally {
      await repo.cleanup();
    }
  });

  it("keeps the transcript resumable after the disposable attempt worktree is removed", async () => {
    const repo = await createTempRepoWithWorktree();
    try {
      const paths = await resolveRunPaths(repo.worktree, "F091");
      const store = new TaskSessionStore({ root: paths.sessions });
      const session = await store.create({ taskId: "T2" });

      expect(session.sessionDir).not.toContain(".harness-output");
      expect(session.sessionDir.startsWith(`${repo.worktree}/`)).toBe(false);
      expect(session.sessionDir.startsWith(`${repo.commonDir}/`)).toBe(true);
      const transcript = await writeTranscript(session.sessionDir, session.sessionId);

      await execa("git", ["worktree", "remove", "--force", repo.worktree], {
        cwd: repo.repository,
      });

      const check = await store.verify("T2");
      expect(check.status).toBe("ok");
      const decision = await store.resume("T2", "attempt-2");
      expect(decision.status).toBe("resumable");
      if (decision.status === "resumable") {
        expect(decision.session.sessionId).toBe(session.sessionId);
        expect(decision.session.sessionDir).toBe(session.sessionDir);
        expect(decision.session.transcriptPath).toBe(transcript);
        await decision.writer.release();
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects task identifiers that escape the session root", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });
    for (const taskId of ["../outside", "a/b", "", ".", "/abs", ".."]) {
      await expect(store.create({ taskId })).rejects.toThrow(/invalid task/);
      await expect(store.verify(taskId)).rejects.toThrow(/invalid task/);
      await expect(store.acquireWriter(taskId, "attempt-1")).rejects.toThrow(/invalid task/);
    }
  });

  it("refuses to re-register a task session under a different session identity", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });
    const session = await store.create({ taskId: "T3" });
    await expect(store.create({ taskId: "T3", sessionId: "other-id" })).rejects.toThrow(
      /already.*session/i,
    );
    const check = await store.verify("T3");
    expect(check.status).toBe("blocked");
    if (check.status === "blocked") {
      expect(check.reason).toBe("transcript_missing");
      expect(check.session?.sessionId).toBe(session.sessionId);
    }
  });

  it("blocks resume when the session or its transcript is missing", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });

    const unknown = await store.verify("T4");
    expect(unknown.status).toBe("blocked");
    if (unknown.status === "blocked") expect(unknown.reason).toBe("session_missing");
    const unknownResume = await store.resume("T4", "attempt-1");
    expect(unknownResume.status).toBe("blocked");
    if (unknownResume.status === "blocked") expect(unknownResume.reason).toBe("session_missing");

    const session = await store.create({ taskId: "T5" });
    const check = await store.verify("T5");
    expect(check.status).toBe("blocked");
    if (check.status === "blocked") {
      expect(check.reason).toBe("transcript_missing");
      expect(check.session?.sessionId).toBe(session.sessionId);
    }
    const resume = await store.resume("T5", "attempt-1");
    expect(resume.status).toBe("blocked");
    if (resume.status === "blocked") expect(resume.reason).toBe("transcript_missing");

    // A transcript for a different session id does not satisfy this session.
    await writeTranscript(session.sessionDir, "someone-elses-session");
    const mismatch = await store.verify("T5");
    expect(mismatch.status).toBe("blocked");
    if (mismatch.status === "blocked") expect(mismatch.reason).toBe("transcript_missing");
  });

  it("blocks resume when the transcript is corrupt", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });
    const session = await store.create({ taskId: "T6" });
    const transcript = await writeTranscript(
      session.sessionDir,
      session.sessionId,
      "{not valid jsonl\n",
    );
    const check = await store.verify("T6");
    expect(check.status).toBe("blocked");
    if (check.status === "blocked") {
      expect(check.reason).toBe("transcript_corrupt");
      expect(check.session?.transcriptPath).toBe(transcript);
    }
    const resume = await store.resume("T6", "attempt-1");
    expect(resume.status).toBe("blocked");
    if (resume.status === "blocked") expect(resume.reason).toBe("transcript_corrupt");
  });

  it("blocks resume when the transcript header belongs to another session", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });
    const session = await store.create({ taskId: "T7" });
    const wrong = join(session.sessionDir, `2026-09-30T01-00-00-000Z_${session.sessionId}.jsonl`);
    await writeFile(
      wrong,
      `${JSON.stringify({ type: "session", version: 3, id: "different-id", timestamp: "t", cwd: "/" })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const check = await store.verify("T7");
    expect(check.status).toBe("blocked");
    if (check.status === "blocked") expect(check.reason).toBe("transcript_corrupt");
  });

  it("blocks resume when the transcript exceeds the size limit", async () => {
    const store = new TaskSessionStore({ root: await tempRoot(), maxTranscriptBytes: 128 });
    const session = await store.create({ taskId: "T8" });
    await writeTranscript(session.sessionDir, session.sessionId);
    const check = await store.verify("T8");
    expect(check.status).toBe("blocked");
    if (check.status === "blocked") expect(check.reason).toBe("transcript_oversize");
    const resume = await store.resume("T8", "attempt-1");
    expect(resume.status).toBe("blocked");
    if (resume.status === "blocked") expect(resume.reason).toBe("transcript_oversize");
  });

  it("rejects symlinked session directories, metadata, and transcripts", async () => {
    const root = await tempRoot();
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "target.jsonl"), "{}\n", { mode: 0o600 });
    const store = new TaskSessionStore({ root });

    const linkedDir = await store.create({ taskId: "T9" });
    const transcript = await writeTranscript(linkedDir.sessionDir, linkedDir.sessionId);
    const moved = join(root, "moved");
    await mkdir(moved);
    const realDir = await store.create({ taskId: "T9-real" });
    await rm(realDir.sessionDir, { recursive: true, force: true });
    await symlink(join(root, "decoy-target"), realDir.sessionDir);
    const dirCheck = await store.verify("T9-real");
    expect(dirCheck.status).toBe("blocked");
    if (dirCheck.status === "blocked") expect(dirCheck.reason).toBe("session_corrupt");

    const linkedMeta = await store.create({ taskId: "T10" });
    const metaPath = join(linkedMeta.sessionDir, "session.json");
    await rm(metaPath);
    await symlink(join(outside, "elsewhere.json"), metaPath);
    const metaCheck = await store.verify("T10");
    expect(metaCheck.status).toBe("blocked");
    if (metaCheck.status === "blocked") expect(metaCheck.reason).toBe("session_corrupt");

    await rm(transcript);
    await symlink(join(outside, "target.jsonl"), transcript);
    const transcriptCheck = await store.verify("T9");
    expect(transcriptCheck.status).toBe("blocked");
    if (transcriptCheck.status === "blocked") {
      expect(transcriptCheck.reason).toBe("transcript_corrupt");
    }
  });

  it("rejects a session directory that is writable by others", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });
    const session = await store.create({ taskId: "T11" });
    await writeTranscript(session.sessionDir, session.sessionId);
    await chmod(session.sessionDir, 0o755);
    const check = await store.verify("T11");
    expect(check.status).toBe("blocked");
    if (check.status === "blocked") expect(check.reason).toBe("session_corrupt");
  });

  it("admits exactly one active writer per transcript", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });
    const session = await store.create({ taskId: "T12" });
    await writeTranscript(session.sessionDir, session.sessionId);

    const first = await store.acquireWriter("T12", "attempt-1");
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;

    const second = await store.acquireWriter("T12", "attempt-2");
    expect(second.status).toBe("blocked");
    if (second.status === "blocked") expect(second.reason).toBe("writer_active");

    const resume = await store.resume("T12", "attempt-2");
    expect(resume.status).toBe("blocked");
    if (resume.status === "blocked") expect(resume.reason).toBe("writer_active");

    await first.writer.release();
    const third = await store.acquireWriter("T12", "attempt-3");
    expect(third.status).toBe("acquired");
    if (third.status !== "acquired") return;

    // A stale writer handle must not drop the successor's lock.
    await first.writer.release();
    const fourth = await store.acquireWriter("T12", "attempt-4");
    expect(fourth.status).toBe("blocked");
    if (fourth.status === "blocked") expect(fourth.reason).toBe("writer_active");
    await third.writer.release();
  });

  it("shares the original generation transcript and isolates fix rounds 4-5", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });
    const original = await store.create({
      taskId: "T20",
      generation: 1,
      profileId: "implementer-devin",
    });
    const transcript = await writeTranscript(original.sessionDir, original.sessionId);

    // Generations 1-4 (initial attempt plus fix rounds 1-3) resume the original slot.
    for (const round of [2, 3, 4]) {
      const decision = await store.resume("T20", `attempt-${round}`, {
        generation: 1,
        profileId: "implementer-devin",
      });
      expect(decision.status).toBe("resumable");
      if (decision.status === "resumable") {
        expect(decision.session.sessionId).toBe(original.sessionId);
        expect(decision.session.sessionDir).toBe(original.sessionDir);
        expect(decision.session.transcriptPath).toBe(transcript);
        await decision.writer.release();
      }
    }

    // Generations 5 and 6 (fix rounds 4-5) each start a distinct fresh session.
    const fifth = await store.create({
      taskId: "T20",
      generation: 5,
      profileId: "implementer-opus",
    });
    const sixth = await store.create({
      taskId: "T20",
      generation: 6,
      profileId: "implementer-opus",
    });
    expect(new Set([original.sessionId, fifth.sessionId, sixth.sessionId]).size).toBe(3);
    expect(fifth.sessionDir).not.toBe(original.sessionDir);
    expect(sixth.sessionDir).not.toBe(fifth.sessionDir);

    await writeTranscript(fifth.sessionDir, fifth.sessionId);
    const escalated = await store.resume("T20", "attempt-5", {
      generation: 5,
      profileId: "implementer-opus",
    });
    expect(escalated.status).toBe("resumable");
    if (escalated.status === "resumable") {
      expect(escalated.session.sessionId).toBe(fifth.sessionId);
      expect(escalated.session.profileId).toBe("implementer-opus");
      await escalated.writer.release();
    }

    // A generation slot never sees a sibling slot's transcript.
    const empty = await store.verify("T20", { generation: 4 });
    expect(empty.status).toBe("blocked");
    if (empty.status === "blocked") expect(empty.reason).toBe("session_missing");

    // Writer locks are per transcript, so slots fence independently.
    const escalatedWriter = await store.acquireWriter("T20", "attempt-5b", { generation: 5 });
    expect(escalatedWriter.status).toBe("acquired");
    const originalWriter = await store.acquireWriter("T20", "attempt-1b", { generation: 1 });
    expect(originalWriter.status).toBe("acquired");
    if (escalatedWriter.status === "acquired") await escalatedWriter.writer.release();
    if (originalWriter.status === "acquired") await originalWriter.writer.release();
  });

  it("binds a stored session to its profile and rejects a different profile", async () => {
    const store = new TaskSessionStore({ root: await tempRoot() });
    const session = await store.create({
      taskId: "T21",
      generation: 1,
      profileId: "implementer-devin",
    });
    await writeTranscript(session.sessionDir, session.sessionId);

    const same = await store.verify("T21", { generation: 1, profileId: "implementer-devin" });
    expect(same.status).toBe("ok");

    const check = await store.verify("T21", { generation: 1, profileId: "implementer-opus" });
    expect(check.status).toBe("blocked");
    if (check.status === "blocked") {
      expect(check.reason).toBe("profile_mismatch");
      expect(check.session?.profileId).toBe("implementer-devin");
    }
    const resume = await store.resume("T21", "attempt-2", {
      generation: 1,
      profileId: "implementer-opus",
    });
    expect(resume.status).toBe("blocked");
    if (resume.status === "blocked") expect(resume.reason).toBe("profile_mismatch");

    // Re-registering the slot under another profile is refused loudly.
    await expect(
      store.create({ taskId: "T21", generation: 1, profileId: "implementer-opus" }),
    ).rejects.toThrow(/different profile/i);
  });
});
