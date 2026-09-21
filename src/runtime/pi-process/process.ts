import { spawn, type ChildProcess } from "node:child_process";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "../../shared/sha256.js";
import { redactDiagnostic } from "../managed/redaction.js";
import { PiEventStreamParser, reducePiEvents } from "./events.js";
import {
  identityMismatchEvidence,
  SystemProcessIdentity,
  type ProcessIdentityPort,
} from "./identity.js";
import type {
  CancellationEvidence,
  PiLaunchSpec,
  PiProcessExit,
  PiProcessObservation,
  PiProcessRecord,
  PiProcessSupervisor,
} from "./types.js";

const ATTEMPT_TOKEN_ENV = "PI_HARNESS_ATTEMPT_TOKEN";

export interface PiProcessSupervisorDependencies {
  readonly identity?: ProcessIdentityPort;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}

interface OwnedProcess {
  readonly child: ChildProcess;
  readonly exit: Promise<PiProcessExit>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function durableCreate(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    process.kill(pid, signal);
  }
}

async function readEventRecords(eventsPath: string) {
  let content = "";
  try {
    content = await readFile(eventsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parser = new PiEventStreamParser();
  return parser.push(content);
}

async function terminalFromFile(eventsPath: string) {
  return reducePiEvents(await readEventRecords(eventsPath)).terminal;
}

async function processExitFromFile(
  eventsPath: string,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null } | undefined> {
  const records = await readEventRecords(eventsPath);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]?.event;
    if (event?.type !== "process_exit") continue;
    return {
      exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
      signal: typeof event.signal === "string" ? event.signal as NodeJS.Signals : null,
    };
  }
  return undefined;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

export class NodePiProcessSupervisor implements PiProcessSupervisor {
  private readonly identity: ProcessIdentityPort;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly owned = new Map<string, OwnedProcess>();

  public constructor(dependencies: PiProcessSupervisorDependencies = {}) {
    this.identity = dependencies.identity ?? new SystemProcessIdentity();
    this.signalProcess = dependencies.signalProcess ?? defaultSignalProcess;
    this.sleep = dependencies.sleep ?? delay;
    this.now = dependencies.now ?? (() => new Date());
  }

  public async launch(spec: PiLaunchSpec): Promise<PiProcessRecord> {
    await mkdir(spec.sessionDir, { recursive: true, mode: 0o700 });
    const eventsPath = join(spec.sessionDir, "events.jsonl");
    const stderrPath = join(spec.sessionDir, "stderr.log");
    const recordPath = join(spec.sessionDir, "process.json");
    await Promise.all([
      open(eventsPath, "a", 0o600).then((file) => file.close()),
      open(stderrPath, "a", 0o600).then((file) => file.close()),
      durableCreate(join(spec.sessionDir, "session.json"), {
        schemaVersion: 1,
        attemptId: spec.attemptId,
        attemptToken: spec.attemptToken,
        sessionId: spec.sessionId,
      }),
    ]);

    const events = await open(eventsPath, "a", 0o600);
    const diagnostics = await open(stderrPath, "a", 0o600);
    const child = spawn(spec.executable, [...spec.argv], {
      cwd: spec.cwd,
      env: { ...spec.env, [ATTEMPT_TOKEN_ENV]: spec.attemptToken },
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid === undefined) throw new Error("Pi process did not receive a pid");
    const pid = child.pid;
    let eventWrites = Promise.resolve();
    let diagnosticWrites = Promise.resolve();
    let diagnosticBuffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      eventWrites = eventWrites.then(async () => {
        await events.write(chunk);
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnosticBuffer += chunk.toString("utf8");
      const lines = diagnosticBuffer.split("\n");
      diagnosticBuffer = lines.pop() ?? "";
      const complete = lines.map((line) => `${redactDiagnostic(line)}\n`).join("");
      if (complete !== "") {
        diagnosticWrites = diagnosticWrites.then(async () => {
          await diagnostics.write(complete, undefined, "utf8");
        });
      }
    });

    try {
      this.signalProcess(pid, "SIGSTOP");
      const observed = await this.identity.capture(pid, spec.executable, spec.attemptToken);
      const record: PiProcessRecord = {
        schemaVersion: 1,
        attemptId: spec.attemptId,
        attemptToken: spec.attemptToken,
        executable: observed.executable,
        argvHash: sha256(JSON.stringify(spec.argv)),
        cwd: spec.cwd,
        pid,
        startIdentity: observed.startIdentity,
        sessionId: spec.sessionId,
        sessionDir: spec.sessionDir,
        eventsPath,
        stderrPath,
        recordPath,
        startedAt: this.now().toISOString(),
      };
      await durableCreate(recordPath, record);

      const exit = new Promise<PiProcessExit>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
          void (async () => {
            await eventWrites;
            if (diagnosticBuffer !== "") {
              const tail = redactDiagnostic(diagnosticBuffer);
              diagnosticWrites = diagnosticWrites.then(async () => {
                await diagnostics.write(tail, undefined, "utf8");
              });
            }
            await diagnosticWrites;
            await events.write(
              `${JSON.stringify({ type: "process_exit", exitCode, signal })}\n`,
              undefined,
              "utf8",
            );
            await Promise.all([events.sync(), diagnostics.sync()]);
            await Promise.all([events.close(), diagnostics.close()]);
            const result = { exitCode, signal, terminal: await terminalFromFile(eventsPath) };
            this.owned.delete(record.attemptId);
            resolve(result);
          })().catch(reject);
        });
      });
      this.owned.set(record.attemptId, { child, exit });
      this.signalProcess(pid, "SIGCONT");
      if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
      else child.stdin?.end();
      return record;
    } catch (error) {
      try {
        this.signalProcess(pid, "SIGKILL");
      } catch {
        // Preserve the launch error.
      }
      await Promise.all([events.close(), diagnostics.close()]);
      throw error;
    }
  }

  public async observe(record: PiProcessRecord): Promise<PiProcessObservation> {
    const owned = this.owned.get(record.attemptId);
    if (owned !== undefined && owned.child.exitCode !== null) {
      return { status: "exited", exit: await owned.exit };
    }
    const observed = await this.identity.inspect(record);
    if (observed !== undefined) {
      const evidence = identityMismatchEvidence(observed, record);
      return evidence.length === 0
        ? { status: "running", record }
        : { status: "identity_mismatch", evidence };
    }
    const persistedExit = await processExitFromFile(record.eventsPath);
    if (persistedExit !== undefined) {
      return {
        status: "exited",
        exit: { ...persistedExit, terminal: await terminalFromFile(record.eventsPath) },
      };
    }
    return { status: "missing" };
  }

  public async wait(record: PiProcessRecord, signal?: AbortSignal): Promise<PiProcessExit> {
    const owned = this.owned.get(record.attemptId);
    if (owned !== undefined) {
      return signal === undefined ? owned.exit : Promise.race([owned.exit, abortPromise(signal)]);
    }
    while (true) {
      if (signal?.aborted === true) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const observation = await this.observe(record);
      if (observation.status === "exited") return observation.exit;
      if (observation.status === "identity_mismatch") {
        throw new Error(`Pi process identity mismatch (${observation.evidence.join(", ")})`);
      }
      if (observation.status === "missing") {
        return {
          exitCode: null,
          signal: null,
          terminal: await terminalFromFile(record.eventsPath),
        };
      }
      await this.sleep(100);
    }
  }

  public async cancel(
    record: PiProcessRecord,
    graceMs = 5_000,
  ): Promise<CancellationEvidence> {
    const owned = this.owned.get(record.attemptId);
    const sent: NodeJS.Signals[] = [];
    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
      const observed = await this.identity.inspect(record);
      if (observed === undefined) break;
      const mismatch = identityMismatchEvidence(observed, record);
      if (mismatch.length > 0) {
        throw new Error(`Refusing to signal process: identity mismatch (${mismatch.join(", ")})`);
      }
      this.signalProcess(record.pid, signal);
      sent.push(signal);
      if (signal !== "SIGKILL") await this.sleep(graceMs);
    }
    const exit = owned === undefined ? null : await owned.exit;
    return { attemptId: record.attemptId, signals: sent, exit };
  }
}

export async function launchPiProcess(
  spec: PiLaunchSpec,
  dependencies: PiProcessSupervisorDependencies = {},
): Promise<PiProcessRecord> {
  return new NodePiProcessSupervisor(dependencies).launch(spec);
}
