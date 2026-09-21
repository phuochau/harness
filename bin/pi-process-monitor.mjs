#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const launchPath = process.argv[2];
if (!launchPath) throw new Error("missing durable launch path");
const launch = JSON.parse(readFileSync(launchPath, "utf8"));
const token = process.env.PI_HARNESS_ATTEMPT_TOKEN;
if (!token) throw new Error("missing attempt token");

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
  startedAt: new Date().toISOString(),
});

const child = spawn(launch.executable, launch.argv, {
  cwd: launch.cwd,
  env: process.env,
  shell: false,
  detached: false,
  stdio: ["pipe", "inherit", "ignore"],
});
const input = readFileSync(launch.stdinPath);
child.stdin.end(input);
const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
});
durableCreate(launch.exitPath, result);
await new Promise((resolve) => process.stdout.write(
  `${JSON.stringify({ type: "process_exit", ...result })}\n`,
  resolve,
));
fsyncSync(1);
process.exitCode = result.exitCode ?? (result.signal === null ? 0 : 1);
