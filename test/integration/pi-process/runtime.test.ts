import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodePiProcessSupervisor } from "../../../src/runtime/pi-process/process.js";
import { processRecord, FakeProcessIdentity } from "../../support/pi-process-fixtures.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "harness-pi-process-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("durable Pi process transport", () => {
  it("persists identity before release and reduces a terminal event stream", async () => {
    const sessionDir = await temporaryDirectory();
    const supervisor = new NodePiProcessSupervisor();
    const script = [
      'process.stdout.write(JSON.stringify({type:"message_end",role:"assistant",content:"RESULT"})+"\\n")',
      'process.stdout.write(JSON.stringify({type:"turn_end",stopReason:"stop"})+"\\n")',
      'process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n")',
      'process.stderr.write("Authorization=secret Bearer abc https://u:p@example.test\\n")',
    ].join(";");

    const record = await supervisor.launch({
      attemptId: "attempt-1",
      attemptToken: "private-attempt-token",
      executable: process.execPath,
      argv: ["-e", script],
      cwd: sessionDir,
      env: {},
      sessionId: "session-1",
      sessionDir,
    });

    const persisted = JSON.parse(await readFile(record.recordPath, "utf8"));
    expect(persisted).toMatchObject({
      attemptId: "attempt-1",
      attemptToken: "private-attempt-token",
      pid: record.pid,
      startIdentity: record.startIdentity,
    });
    expect(JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"))).toMatchObject({
      attemptId: "attempt-1",
      attemptToken: "private-attempt-token",
    });

    const exit = await supervisor.wait(record, AbortSignal.timeout(5_000));
    expect(exit).toMatchObject({
      exitCode: 0,
      signal: null,
      terminal: {
        settled: true,
        acceptedStopReason: true,
        completeToolResults: true,
        finalAssistantText: "RESULT",
      },
    });
    expect(await readFile(record.stderrPath, "utf8")).toBe("");
  });

  it("preserves a non-zero exit after an otherwise accepted terminal stream", async () => {
    const sessionDir = await temporaryDirectory();
    const supervisor = new NodePiProcessSupervisor();
    const script = [
      'process.stdout.write(JSON.stringify({type:"message_end",role:"assistant",content:"RESULT"})+"\\n")',
      'process.stdout.write(JSON.stringify({type:"turn_end",stopReason:"stop"})+"\\n")',
      'process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n")',
      "process.exitCode=7",
    ].join(";");
    const record = await supervisor.launch({
      attemptId: "attempt-failed-exit",
      attemptToken: "token-failed-exit",
      executable: process.execPath,
      argv: ["-e", script],
      cwd: sessionDir,
      env: {},
      sessionId: "session-failed-exit",
      sessionDir,
    });

    await expect(supervisor.wait(record, AbortSignal.timeout(5_000))).resolves.toMatchObject({
      exitCode: 7,
      signal: null,
      terminal: { settled: true, acceptedStopReason: true, completeToolResults: true },
    });
  });

  it("refuses terminal evidence without the monitor's durable exit status", async () => {
    const sessionDir = await temporaryDirectory();
    const eventsPath = join(sessionDir, "events.jsonl");
    await writeFile(eventsPath, [
      JSON.stringify({ type: "message_end", role: "assistant", content: "RESULT" }),
      JSON.stringify({ type: "turn_end", stopReason: "stop" }),
      JSON.stringify({ type: "agent_settled" }),
      "",
    ].join("\n"));
    const record = processRecord({
      sessionDir,
      eventsPath,
      stderrPath: join(sessionDir, "stderr.log"),
      recordPath: join(sessionDir, "process.json"),
    });
    const supervisor = new NodePiProcessSupervisor({
      identity: new FakeProcessIdentity(undefined),
    });

    expect(await supervisor.observe(record)).toEqual({ status: "missing" });
  });

  it("refuses terminal evidence when the recorded pid has been reused", async () => {
    const sessionDir = await temporaryDirectory();
    const eventsPath = join(sessionDir, "events.jsonl");
    await writeFile(eventsPath, [
      JSON.stringify({ type: "message_end", role: "assistant", content: "RESULT" }),
      JSON.stringify({ type: "turn_end", stopReason: "stop" }),
      JSON.stringify({ type: "agent_settled" }),
      "",
    ].join("\n"));
    const record = processRecord({
      sessionDir,
      eventsPath,
      stderrPath: join(sessionDir, "stderr.log"),
      recordPath: join(sessionDir, "process.json"),
    });
    const supervisor = new NodePiProcessSupervisor({
      identity: new FakeProcessIdentity({
        pid: record.pid,
        startIdentity: "reused-pid-start",
        executable: "/usr/bin/unrelated",
        attemptToken: record.attemptToken,
      }),
    });

    expect(await supervisor.observe(record)).toMatchObject({
      status: "identity_mismatch",
      evidence: expect.arrayContaining(["start identity mismatch", "executable mismatch"]),
    });
  });

  it("returns the same durable monitor instead of spawning a duplicate", async () => {
    const sessionDir = await temporaryDirectory();
    const supervisor = new NodePiProcessSupervisor();
    const spec = {
      attemptId: "attempt-idempotent",
      attemptToken: "token-idempotent",
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: sessionDir,
      env: {},
      sessionId: "session-idempotent",
      sessionDir,
    } as const;
    const first = await supervisor.launch(spec);
    const second = await new NodePiProcessSupervisor().launch(spec);
    expect(second).toEqual(first);
    await supervisor.cancel(first, 25);
  });

  it("observes a matching live process without launching a replacement", async () => {
    const sessionDir = await temporaryDirectory();
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-live",
      attemptToken: "token-live",
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: sessionDir,
      env: {},
      sessionId: "session-live",
      sessionDir,
    });
    const recoveredSupervisor = new NodePiProcessSupervisor();
    expect(await recoveredSupervisor.observe(record)).toEqual({ status: "running", record });
    await recoveredSupervisor.cancel(record, 50);
  });

  it("observes the live attempt token instead of trusting the persisted token", async () => {
    const sessionDir = await temporaryDirectory();
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-token",
      attemptToken: "actual-live-token",
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: sessionDir,
      env: {},
      sessionId: "session-token",
      sessionDir,
    });
    const forged = { ...record, attemptToken: "forged-persisted-token" };
    await expect(new NodePiProcessSupervisor().observe(forged)).resolves.toMatchObject({
      status: "identity_mismatch",
      evidence: expect.arrayContaining(["attempt token mismatch"]),
    });
    await supervisor.cancel(record, 25);
  });

  it("continues an exactly matching process left stopped by a controller crash", async () => {
    const record = processRecord();
    const identity = new FakeProcessIdentity({
      pid: record.pid,
      startIdentity: record.startIdentity,
      executable: record.executable,
      attemptToken: record.attemptToken,
      stopped: true,
    });
    const signals: string[] = [];
    const supervisor = new NodePiProcessSupervisor({
      identity,
      signalProcess: (_pid, signal) => signals.push(signal),
    });

    await expect(supervisor.observe(record)).resolves.toEqual({ status: "running", record });
    expect(signals).toEqual(["SIGCONT"]);
  });
});
