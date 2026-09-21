import { generateKeyPairSync } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
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

  it("replays an unclaimed launch intent without spawning duplicate providers", async () => {
    const sessionDir = await temporaryDirectory();
    const attemptId = "attempt-unclaimed";
    const attemptToken = "token-unclaimed";
    const sessionId = "session-unclaimed";
    const argv = ["-e", "setTimeout(() => {}, 10000)"];
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify({
      schemaVersion: 1, attemptId, attemptToken, sessionId,
    })}\n`);
    await writeFile(join(sessionDir, "stdin.bin"), "");
    await writeFile(join(sessionDir, "launch.json"), `${JSON.stringify({
      schemaVersion: 1,
      attemptId,
      executable: process.execPath,
      argv,
      cwd: sessionDir,
      sessionId,
      sessionDir,
      eventsPath: join(sessionDir, "events.jsonl"),
      stderrPath: join(sessionDir, "stderr.log"),
      recordPath: join(sessionDir, "process.json"),
      providerPath: join(sessionDir, "provider.json"),
      exitPath: join(sessionDir, "exit.json"),
      stdinPath: join(sessionDir, "stdin.bin"),
    })}\n`);
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId, attemptToken, executable: process.execPath, argv,
      cwd: sessionDir, env: {}, sessionId, sessionDir,
    });
    await expect(supervisor.observe(record)).resolves.toMatchObject({ status: "running" });
    await supervisor.cancel(record, 25);
  });

  it("keeps monitor control receipts outside the worker session directory", async () => {
    const root = await temporaryDirectory();
    const sessionDir = join(root, "worker-session");
    const controlDir = join(root, "controller-state");
    const forgedExit = join(sessionDir, "exit.json");
    const script = [
      `require("node:fs").mkdirSync(${JSON.stringify(sessionDir)},{recursive:true})`,
      `require("node:fs").writeFileSync(${JSON.stringify(forgedExit)},'{"exitCode":0,"signal":null}\\n')`,
      "setTimeout(() => {}, 10000)",
    ].join(";");
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-control-root",
      attemptToken: "token-control-root",
      executable: process.execPath,
      argv: ["-e", script],
      cwd: root,
      env: {},
      sessionId: "session-control-root",
      sessionDir,
      controlDir,
    });
    await waitFor(forgedExit);
    expect(record.recordPath.startsWith(`${controlDir}/`)).toBe(true);
    await expect(supervisor.observe(record)).resolves.toMatchObject({ status: "running" });
    await supervisor.cancel(record, 25);
  });

  it("uses and removes the controller-prepared receipt signing key", async () => {
    const root = await temporaryDirectory();
    const controlDir = join(root, "control");
    await mkdir(controlDir);
    const receiptPrivateKeyPath = join(controlDir, "receipt-private.pem");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const receiptPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeFile(
      receiptPrivateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-bound-key",
      attemptToken: "token-bound-key",
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: root,
      env: {},
      sessionId: "session-bound-key",
      sessionDir: join(root, "session"),
      controlDir,
      receiptPrivateKeyPath,
      receiptPublicKey,
    });
    expect(record.receiptPublicKey).toBe(receiptPublicKey);
    await expect(access(receiptPrivateKeyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await supervisor.cancel(record, 25);
  });

  it("retains the prepared receipt key until a monitor claims the launch", async () => {
    const root = await temporaryDirectory();
    const controlDir = join(root, "control");
    await mkdir(controlDir);
    const receiptPrivateKeyPath = join(controlDir, "receipt-private.pem");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    await writeFile(
      receiptPrivateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    const supervisor = new NodePiProcessSupervisor({
      spawnProcess: (() => { throw new Error("simulated controller interruption"); }) as any,
    });
    await expect(supervisor.launch({
      attemptId: "attempt-pre-monitor-crash",
      attemptToken: "token-pre-monitor-crash",
      executable: process.execPath,
      argv: ["-e", ""],
      cwd: root,
      env: {},
      sessionId: "session-pre-monitor-crash",
      sessionDir: join(root, "session"),
      controlDir,
      receiptPrivateKeyPath,
      receiptPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    })).rejects.toThrow("simulated controller interruption");
    await expect(readFile(receiptPrivateKeyPath, "utf8")).resolves.toContain(
      "BEGIN PRIVATE KEY",
    );
  });

  it("persists signed completion when the provider exits before identity capture", async () => {
    const root = await temporaryDirectory();
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-fast-exit",
      attemptToken: "token-fast-exit",
      executable: "/usr/bin/true",
      argv: [],
      cwd: root,
      env: {},
      sessionId: "session-fast-exit",
      sessionDir: join(root, "session"),
      controlDir: join(root, "control"),
    });
    await expect(supervisor.wait(record, AbortSignal.timeout(5_000))).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
    });
  });

  it("rejects a provider-forged exit receipt instead of masking failure", async () => {
    const root = await temporaryDirectory();
    const controlDir = join(root, "control");
    const forgedExit = join(controlDir, "exit.json");
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(forgedExit)},JSON.stringify({schemaVersion:1,exitCode:0,signal:null,signature:"forged"})+"\\n")`,
      'process.stdout.write(JSON.stringify({type:"message_end",role:"assistant",content:"RESULT"})+"\\n")',
      'process.stdout.write(JSON.stringify({type:"turn_end",stopReason:"stop"})+"\\n")',
      'process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n")',
      "process.exitCode=7",
    ].join(";");
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-forged-exit",
      attemptToken: "token-forged-exit",
      executable: process.execPath,
      argv: ["-e", script],
      cwd: root,
      env: {},
      sessionId: "session-forged-exit",
      sessionDir: join(root, "session"),
      controlDir,
    });

    await expect(supervisor.wait(record, AbortSignal.timeout(5_000))).rejects.toThrow(
      "invalid durable Pi process exit signature",
    );
  });

  it("kills a signed provider orphan after the monitor is lost", async () => {
    const root = await temporaryDirectory();
    const pidPath = join(root, "provider.pid");
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-orphan",
      attemptToken: "token-orphan",
      executable: process.execPath,
      argv: ["-e", [
        `require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid))`,
        "setInterval(()=>{},1000)",
      ].join(";")],
      cwd: root,
      env: {},
      sessionId: "session-orphan",
      sessionDir: join(root, "session"),
      controlDir: join(root, "control"),
    });
    await waitFor(pidPath);
    const providerPid = Number(await readFile(pidPath, "utf8"));
    const monitorExit = supervisor.wait(record).catch(() => undefined);
    process.kill(record.pid, "SIGKILL");

    const evidence = await new NodePiProcessSupervisor().cancel(record, 25);
    expect(evidence.signals).toEqual(["SIGKILL"]);
    expect(() => process.kill(providerPid, 0)).toThrow();
    await monitorExit;
  });

  it("kills surviving descendants after the direct provider exits", async () => {
    const root = await temporaryDirectory();
    const pidPath = join(root, "descendant.pid");
    const script = [
      "const {spawn}=require('node:child_process')",
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})`,
      `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(child.pid))`,
      "child.unref()",
    ].join(";");
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-descendant",
      attemptToken: "token-descendant",
      executable: process.execPath,
      argv: ["-e", script],
      cwd: root,
      env: {},
      sessionId: "session-descendant",
      sessionDir: join(root, "session"),
      controlDir: join(root, "control"),
    });
    await waitFor(pidPath);
    const descendantPid = Number(await readFile(pidPath, "utf8"));
    try {
      await supervisor.wait(record, AbortSignal.timeout(5_000));
      const evidence = await new NodePiProcessSupervisor().cancel(record, 25);
      expect(evidence.signals).toEqual(["SIGKILL"]);
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
  });

  it("escalates through SIGKILL when a provider traps graceful signals", async () => {
    const root = await temporaryDirectory();
    const pidPath = join(root, "provider.pid");
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid))`,
      "process.on('SIGINT',()=>{})",
      "process.on('SIGTERM',()=>{})",
      "setInterval(()=>{},1000)",
    ].join(";");
    const supervisor = new NodePiProcessSupervisor();
    const record = await supervisor.launch({
      attemptId: "attempt-stubborn",
      attemptToken: "token-stubborn",
      executable: process.execPath,
      argv: ["-e", script],
      cwd: root,
      env: {},
      sessionId: "session-stubborn",
      sessionDir: join(root, "session"),
      controlDir: join(root, "control"),
    });
    await waitFor(pidPath);
    const providerPid = Number(await readFile(pidPath, "utf8"));
    const evidence = await supervisor.cancel(record, 25);
    expect(evidence.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(() => process.kill(providerPid, 0)).toThrow();
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
