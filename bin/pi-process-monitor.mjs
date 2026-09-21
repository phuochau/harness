#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { createHash, createPublicKey, randomUUID, sign as cryptoSign } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const launchPath = process.argv[2];
if (!launchPath) throw new Error("missing durable launch path");
const launch = JSON.parse(readFileSync(launchPath, "utf8"));
const token = process.env.PI_HARNESS_ATTEMPT_TOKEN;
if (!token) throw new Error("missing attempt token");
const receiptPrivateKey = readFileSync(0, "utf8");
if (!receiptPrivateKey) throw new Error("missing receipt signing key");
const receiptPublicKey = createPublicKey(receiptPrivateKey)
  .export({ type: "spki", format: "pem" }).toString();
// The monitor owns escalation. Group signals normally reach both processes;
// direct-signal fallbacks are forwarded to the provider while the monitor
// remains alive to persist its exit receipt.
let child;
const pendingSignals = [];
function forward(signal) {
  if (child === undefined) {
    pendingSignals.push(signal);
    return;
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
// SIGUSR2 is the private fallback for a logical SIGKILL when the operating
// system refuses a process-group signal.
process.on("SIGUSR2", () => forward("SIGKILL"));

async function identity(pid) {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    const fields = stat.slice(closing + 2).split(" ");
    return { start: fields[19], executable: realpathSync(`/proc/${pid}/exe`) };
  }
  if (process.platform === "darwin") {
    const [{ stdout: start }, { stdout: executable }] = await Promise.all([
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "comm="]),
    ]);
    return { start: start.trim(), executable: realpathSync(executable.trim()) };
  }
  throw new Error(`unsupported process identity platform: ${process.platform}`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function durableCreate(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    unlinkSync(temporary);
  }
}

function signed(payload) {
  return {
    ...payload,
    signature: cryptoSign(
      null,
      Buffer.from(JSON.stringify(payload)),
      receiptPrivateKey,
    ).toString("base64"),
  };
}

const observed = await identity(process.pid);
durableCreate(launch.recordPath, {
  schemaVersion: 1,
  attemptId: launch.attemptId,
  attemptToken: token,
  executable: observed.executable,
  argvHash: sha256(JSON.stringify(launch.argv)),
  cwd: launch.cwd,
  pid: process.pid,
  startIdentity: sha256(`${process.pid}\0${observed.start}\0${observed.executable}\0${token}`),
  sessionId: launch.sessionId,
  sessionDir: launch.sessionDir,
  eventsPath: launch.eventsPath,
  stderrPath: launch.stderrPath,
  recordPath: launch.recordPath,
  providerPath: launch.providerPath,
  receiptPublicKey,
  startedAt: new Date().toISOString(),
});

const childEnvironment = { ...process.env };
delete childEnvironment.PI_HARNESS_ATTEMPT_TOKEN;
const providerToken = randomUUID();
childEnvironment.PI_HARNESS_PROVIDER_TOKEN = providerToken;
child = spawn(launch.executable, launch.argv, {
  cwd: launch.cwd,
  env: childEnvironment,
  shell: false,
  detached: false,
  stdio: ["pipe", "inherit", "ignore"],
});
for (const signal of pendingSignals.splice(0)) forward(signal);
if (child.pid !== undefined) {
  const providerIdentity = await identity(child.pid);
  const providerPayload = {
    schemaVersion: 1,
    attemptId: launch.attemptId,
    pid: child.pid,
    processGroupId: process.pid,
    startIdentity: sha256(
      `${child.pid}\0${providerIdentity.start}\0${providerIdentity.executable}\0${providerToken}`,
    ),
    executable: providerIdentity.executable,
    attemptToken: providerToken,
  };
  durableCreate(launch.providerPath, signed(providerPayload));
}
const input = readFileSync(launch.stdinPath);
child.stdin.end(input);
const result = await new Promise((resolve, reject) => {
  child.once("error", () => resolve({ exitCode: 1, signal: null }));
  child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
});
durableCreate(launch.exitPath, signed({ schemaVersion: 1, ...result }));
await new Promise((resolve) => process.stdout.write(
  `${JSON.stringify({ type: "process_exit", ...result })}\n`,
  resolve,
));
fsyncSync(1);
process.exitCode = result.exitCode ?? (result.signal === null ? 0 : 1);
