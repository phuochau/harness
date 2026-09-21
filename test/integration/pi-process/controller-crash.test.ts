import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { NodePiProcessSupervisor } from "../../../src/runtime/pi-process/process.js";
import type { PiProcessRecord } from "../../../src/runtime/pi-process/types.js";

const ownerMode = process.env.HARNESS_PROCESS_OWNER_FIXTURE === "1";

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

it.runIf(ownerMode)("owns the detached fixture process", async () => {
  const sessionDir = process.env.HARNESS_PROCESS_SESSION_DIR;
  if (sessionDir === undefined) throw new Error("missing fixture session directory");
  const supervisor = new NodePiProcessSupervisor();
  await supervisor.launch({
    attemptId: "controller-crash-attempt",
    attemptToken: "controller-crash-token",
    executable: process.execPath,
    argv: ["-e", [
      "setTimeout(() => {",
      "process.stdout.write(JSON.stringify({type:'message_end',role:'assistant',content:'RESULT'})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'turn_end',stopReason:'stop'})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');",
      "}, 500);",
    ].join("")],
    cwd: sessionDir,
    env: {},
    sessionId: "controller-crash-session",
    sessionDir,
  });
  await writeFile(join(sessionDir, "owner-ready"), "ready\n", "utf8");
  await new Promise<void>(() => undefined);
}, 30_000);

it.runIf(!ownerMode)("survives controller death and recovers from terminal evidence", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "harness-controller-crash-"));
  const testPath = resolve("test/integration/pi-process/controller-crash.test.ts");
  const controller = spawn(process.execPath, [
    resolve("node_modules/vitest/vitest.mjs"),
    "run",
    testPath,
    "--pool=threads",
    "--maxWorkers=1",
    "--reporter=dot",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HARNESS_PROCESS_OWNER_FIXTURE: "1",
      HARNESS_PROCESS_SESSION_DIR: sessionDir,
    },
    stdio: "ignore",
  });
  try {
    await waitFor(join(sessionDir, "owner-ready"), 10_000);
    const record = JSON.parse(
      await readFile(join(sessionDir, "process.json"), "utf8"),
    ) as PiProcessRecord;
    controller.kill("SIGKILL");
    await once(controller, "exit");

    const recovered = new NodePiProcessSupervisor();
    const exit = await recovered.wait(record, AbortSignal.timeout(10_000));
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
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) {
      controller.kill("SIGKILL");
    }
    await rm(sessionDir, { recursive: true, force: true });
  }
}, 20_000);
