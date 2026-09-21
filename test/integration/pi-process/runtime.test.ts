import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodePiProcessSupervisor } from "../../../src/runtime/pi-process/process.js";

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
    expect(await readFile(record.stderrPath, "utf8")).toBe(
      "Authorization=[REDACTED] Bearer [REDACTED] https://[REDACTED]@example.test\n",
    );
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
});
