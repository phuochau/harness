import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../shared/sha256.js";
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
  PiProviderProcessRecord,
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

async function durableCreate(path: string, value: unknown): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value)}\n`;
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(serialized, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readFile(path, "utf8") !== serialized) {
        throw new Error(`durable launch conflict at ${path}`);
      }
      return false;
    }
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return true;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function durableCreateBytes(path: string, value: Uint8Array): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(Buffer.from(value))) {
      throw new Error(`durable launch conflict at ${path}`);
    }
    return false;
  }
}

async function readProcessRecord(path: string): Promise<PiProcessRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PiProcessRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function verifySignature(
  payload: Readonly<Record<string, unknown>>,
  signature: string,
  publicKey: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(JSON.stringify(payload)),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

async function readProviderRecord(
  record: PiProcessRecord,
): Promise<PiProviderProcessRecord | undefined> {
  try {
    const info = await lstat(record.providerPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024) {
      throw new Error("durable Pi provider record is not a bounded regular file");
    }
    const value: unknown = JSON.parse(await readFile(record.providerPath, "utf8"));
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "attemptId,attemptToken,executable,pid,processGroupId,schemaVersion,signature,startIdentity" ||
      (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      (value as { attemptId?: unknown }).attemptId !== record.attemptId ||
      typeof (value as { pid?: unknown }).pid !== "number" ||
      (value as { processGroupId?: unknown }).processGroupId !== record.pid ||
      typeof (value as { startIdentity?: unknown }).startIdentity !== "string" ||
      typeof (value as { executable?: unknown }).executable !== "string" ||
      typeof (value as { attemptToken?: unknown }).attemptToken !== "string" ||
      typeof (value as { signature?: unknown }).signature !== "string"
    ) throw new Error("invalid durable Pi provider record");
    const typed = value as PiProviderProcessRecord;
    const payload = {
      schemaVersion: typed.schemaVersion,
      attemptId: typed.attemptId,
      pid: typed.pid,
      processGroupId: typed.processGroupId,
      startIdentity: typed.startIdentity,
      executable: typed.executable,
      attemptToken: typed.attemptToken,
    };
    if (!verifySignature(payload, typed.signature, record.receiptPublicKey)) {
      throw new Error("invalid durable Pi provider signature");
    }
    return typed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertMatchingRecord(record: PiProcessRecord, spec: PiLaunchSpec): void {
  if (
    record.schemaVersion !== 1 ||
    record.attemptId !== spec.attemptId ||
    record.attemptToken !== spec.attemptToken ||
    record.sessionId !== spec.sessionId ||
    record.sessionDir !== spec.sessionDir ||
    record.cwd !== spec.cwd ||
    record.argvHash !== sha256(JSON.stringify(spec.argv))
    || typeof record.receiptPublicKey !== "string"
    || record.receiptPublicKey.length === 0
    || record.providerPath !== join(dirname(record.recordPath), "provider.json")
  ) {
    throw new Error(`durable Pi process record does not match attempt ${spec.attemptId}`);
  }
}

function providerIdentityMismatchEvidence(
  observed: Awaited<ReturnType<ProcessIdentityPort["inspectPid"]>>,
  provider: PiProviderProcessRecord,
): readonly string[] {
  if (observed === undefined) return ["provider process is missing"];
  const evidence: string[] = [];
  if (observed.pid !== provider.pid) evidence.push("provider pid mismatch");
  if (observed.startIdentity !== provider.startIdentity) evidence.push("provider start identity mismatch");
  if (observed.executable !== provider.executable) evidence.push("provider executable mismatch");
  if (observed.attemptToken !== provider.attemptToken) evidence.push("provider token mismatch");
  return evidence;
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals): void {
  if (signal !== "SIGKILL") {
    try {
      // The monitor forwards graceful signals exactly once to its provider.
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    try {
      // SIGUSR2 asks the monitor to force-kill its provider while retaining
      // ownership of the exit receipt.
      process.kill(pid, "SIGUSR2");
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") {
        throw fallbackError;
      }
    }
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
  sessionDir: string,
  publicKey: string,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null } | undefined> {
  try {
    const path = join(sessionDir, "exit.json");
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024) {
      throw new Error("durable Pi process exit record is not a bounded regular file");
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "exitCode,schemaVersion,signal,signature" ||
      (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Object.prototype.hasOwnProperty.call(value, "exitCode") ||
      !Object.prototype.hasOwnProperty.call(value, "signal") ||
      ((value as { exitCode?: unknown }).exitCode !== null &&
        typeof (value as { exitCode?: unknown }).exitCode !== "number") ||
      ((value as { signal?: unknown }).signal !== null &&
        typeof (value as { signal?: unknown }).signal !== "string") ||
      typeof (value as { signature?: unknown }).signature !== "string"
    ) {
      throw new Error("invalid durable Pi process exit record");
    }
    const payload = {
      schemaVersion: 1 as const,
      exitCode: (value as { exitCode: number | null }).exitCode,
      signal: (value as { signal: NodeJS.Signals | null }).signal,
    };
    if (!verifySignature(
      payload,
      (value as { signature: string }).signature,
      publicKey,
    )) throw new Error("invalid durable Pi process exit signature");
    return { exitCode: payload.exitCode, signal: payload.signal };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  private readonly owned = new Map<string, OwnedProcess>();

  public constructor(dependencies: PiProcessSupervisorDependencies = {}) {
    this.identity = dependencies.identity ?? new SystemProcessIdentity();
    this.signalProcess = dependencies.signalProcess ?? defaultSignalProcess;
    this.sleep = dependencies.sleep ?? delay;
  }

  public async launch(spec: PiLaunchSpec): Promise<PiProcessRecord> {
    const controlDir = spec.controlDir ?? spec.sessionDir;
    await Promise.all([
      mkdir(spec.sessionDir, { recursive: true, mode: 0o700 }),
      mkdir(controlDir, { recursive: true, mode: 0o700 }),
    ]);
    const eventsPath = join(controlDir, "events.jsonl");
    const stderrPath = join(controlDir, "stderr.log");
    const recordPath = join(controlDir, "process.json");
    const providerPath = join(controlDir, "provider.json");
    const launchPath = join(controlDir, "launch.json");
    const stdinPath = join(controlDir, "stdin.bin");
    const monitorPath = fileURLToPath(
      new URL("../../../bin/pi-process-monitor.mjs", import.meta.url),
    );
    const launchIntent = {
      schemaVersion: 1,
      attemptId: spec.attemptId,
      executable: spec.executable,
      argv: [...spec.argv],
      cwd: spec.cwd,
      sessionId: spec.sessionId,
      sessionDir: spec.sessionDir,
      eventsPath,
      stderrPath,
      recordPath,
      providerPath,
      exitPath: join(controlDir, "exit.json"),
      stdinPath,
    };
    await Promise.all([
      open(eventsPath, "a", 0o600).then((file) => file.close()),
      open(stderrPath, "a", 0o600).then((file) => file.close()),
    ]);
    await durableCreate(join(controlDir, "session.json"), {
        schemaVersion: 1,
        attemptId: spec.attemptId,
        attemptToken: spec.attemptToken,
        sessionId: spec.sessionId,
    });
    await durableCreateBytes(stdinPath, spec.stdin ?? new Uint8Array());
    const launchCreated = await durableCreate(launchPath, launchIntent);
    if (!launchCreated) {
      const existing = await readProcessRecord(recordPath);
      if (existing !== undefined) {
        assertMatchingRecord(existing, spec);
        return existing;
      }
      // A monitor claims process.json before it starts the provider. Replaying
      // an unclaimed launch is safe: concurrent monitors race that atomic
      // claim and only the winner can spawn a provider.
    }
    const events = await open(eventsPath, "a", 0o600);
    const { privateKey } = generateKeyPairSync("ed25519");
    const receiptPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const child = spawn(process.execPath, [monitorPath, launchPath], {
      cwd: spec.cwd,
      env: { ...spec.env, [ATTEMPT_TOKEN_ENV]: spec.attemptToken },
      shell: false,
      detached: true,
      // The detached monitor owns the Pi child and durable exit evidence.
      // Provider stderr stays suppressed because it can contain credentials.
      stdio: ["pipe", events.fd, "ignore"],
    });
    if (child.pid === undefined) throw new Error("Pi process did not receive a pid");
    if (child.stdin === null) throw new Error("Pi process monitor stdin is unavailable");
    child.stdin.end(receiptPrivateKey);
    const pid = child.pid;
    let launchedRecord: PiProcessRecord | undefined;
    const exit = new Promise<PiProcessExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        void (async () => {
          await events.close();
          const currentRecord = launchedRecord ?? await readProcessRecord(recordPath);
          if (currentRecord === undefined) {
            throw new Error("Pi process exited before persisting its identity");
          }
          const persisted = await processExitFromFile(
            controlDir,
            currentRecord.receiptPublicKey,
          );
          const result = persisted ?? { exitCode, signal };
          this.owned.delete(spec.attemptId);
          resolve({ ...result, terminal: await terminalFromFile(eventsPath) });
        })().catch(reject);
      });
    });
    void exit.catch(() => undefined);
    try {
      let record: PiProcessRecord | undefined;
      for (let attempt = 0; attempt < 100 && record === undefined; attempt += 1) {
        record = await readProcessRecord(recordPath);
        if (record === undefined) await this.sleep(50);
      }
      if (record === undefined) {
        throw new Error(`Pi process monitor did not persist identity for attempt ${spec.attemptId}`);
      }
      assertMatchingRecord(record, spec);
      launchedRecord = record;
      let provider = await readProviderRecord(record);
      let earlyExit: Awaited<ReturnType<typeof processExitFromFile>>;
      for (let attempt = 0; attempt < 100 && provider === undefined; attempt += 1) {
        earlyExit = await processExitFromFile(controlDir, record.receiptPublicKey);
        if (earlyExit !== undefined) break;
        await this.sleep(50);
        provider = await readProviderRecord(record);
      }
      if (provider === undefined && earlyExit === undefined) {
        throw new Error(`Pi process monitor did not persist provider identity for attempt ${spec.attemptId}`);
      }
      if (record.pid !== pid) {
        // This monitor lost the durable claim to an earlier/replayed monitor.
        // It exits before spawning a provider, so return the winning record.
        return record;
      }
      this.owned.set(record.attemptId, { child, exit });
      return record;
    } catch (error) {
      try {
        this.signalProcess(pid, "SIGKILL");
      } catch {
        // Preserve the launch error.
      }
      await events.close();
      throw error;
    }
  }

  public async observe(record: PiProcessRecord): Promise<PiProcessObservation> {
    const owned = this.owned.get(record.attemptId);
    if (
      owned !== undefined &&
      (owned.child.exitCode !== null || owned.child.signalCode !== null)
    ) {
      return { status: "exited", exit: await owned.exit };
    }
    const observed = await this.identity.inspect(record);
    if (observed !== undefined) {
      const evidence = identityMismatchEvidence(observed, record);
      if (evidence.length === 0) {
        if (observed.stopped === true) this.signalProcess(record.pid, "SIGCONT");
        return { status: "running", record };
      }
      const persistedExit = await processExitFromFile(
        dirname(record.recordPath),
        record.receiptPublicKey,
      );
      if (persistedExit !== undefined) {
        return {
          status: "exited",
          exit: { ...persistedExit, terminal: await terminalFromFile(record.eventsPath) },
        };
      }
      return { status: "identity_mismatch", evidence };
    }
    const persistedExit = await processExitFromFile(
      dirname(record.recordPath),
      record.receiptPublicKey,
    );
    if (persistedExit !== undefined) {
      return {
        status: "exited",
        exit: { ...persistedExit, terminal: await terminalFromFile(record.eventsPath) },
      };
    }
    const provider = await readProviderRecord(record);
    if (provider !== undefined) {
      const providerIdentity = await this.identity.inspectPid(
        provider.pid,
        provider.attemptToken,
      );
      if (providerIdentity !== undefined) {
        const evidence = providerIdentityMismatchEvidence(providerIdentity, provider);
        return {
          status: "identity_mismatch",
          evidence: evidence.length === 0
            ? ["Pi monitor is missing while its provider remains alive"]
            : evidence,
        };
      }
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
      if (observed === undefined) {
        const provider = await readProviderRecord(record);
        if (provider === undefined) {
          throw new Error("cannot verify cancellation after Pi monitor loss");
        }
        const providerIdentity = await this.identity.inspectPid(
          provider.pid,
          provider.attemptToken,
        );
        if (providerIdentity === undefined) break;
        const providerMismatch = providerIdentityMismatchEvidence(providerIdentity, provider);
        if (providerMismatch.length > 0) {
          throw new Error(
            `Refusing to signal provider process: identity mismatch (${providerMismatch.join(", ")})`,
          );
        }
        this.signalProcess(record.pid, "SIGKILL");
        sent.push("SIGKILL");
        break;
      }
      const mismatch = identityMismatchEvidence(observed, record);
      if (mismatch.length > 0) {
        throw new Error(`Refusing to signal process: identity mismatch (${mismatch.join(", ")})`);
      }
      this.signalProcess(record.pid, signal);
      sent.push(signal);
      if (signal !== "SIGKILL") await this.sleep(graceMs);
    }
    if (sent.includes("SIGKILL")) {
      let terminated = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const observed = await this.identity.inspect(record);
        const provider = await readProviderRecord(record);
        const providerIdentity = provider === undefined
          ? undefined
          : await this.identity.inspectPid(provider.pid, provider.attemptToken);
        const monitorGone = observed === undefined ||
          identityMismatchEvidence(observed, record).length > 0;
        const providerGone = provider === undefined || providerIdentity === undefined ||
          providerIdentityMismatchEvidence(providerIdentity, provider).length > 0;
        if (monitorGone && providerGone) {
          terminated = true;
          break;
        }
        await this.sleep(25);
      }
      if (!terminated) throw new Error("Pi process survived SIGKILL escalation");
    }
    const exit = owned === undefined ? null : await owned.exit.catch(() => null);
    return { attemptId: record.attemptId, signals: sent, exit };
  }
}

export async function launchPiProcess(
  spec: PiLaunchSpec,
  dependencies: PiProcessSupervisorDependencies = {},
): Promise<PiProcessRecord> {
  return new NodePiProcessSupervisor(dependencies).launch(spec);
}
