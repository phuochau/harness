import { join } from "node:path";
import type {
  LiveProcessIdentity,
  ProcessIdentityPort,
} from "../../src/runtime/pi-process/identity.js";
import {
  NodePiProcessSupervisor,
  type PiProcessSupervisorDependencies,
} from "../../src/runtime/pi-process/process.js";
import type { PiProcessRecord } from "../../src/runtime/pi-process/types.js";

export function processRecord(
  overrides: Partial<PiProcessRecord> = {},
): PiProcessRecord {
  const sessionDir = "/managed/attempt/session";
  return {
    schemaVersion: 1,
    attemptId: "attempt-1",
    attemptToken: "token-1",
    executable: "/managed/bin/pi",
    argvHash: `sha256:${"a".repeat(64)}`,
    cwd: "/repo",
    pid: 42,
    startIdentity: "start-old",
    sessionId: "session-1",
    sessionDir,
    eventsPath: join(sessionDir, "events.jsonl"),
    stderrPath: join(sessionDir, "stderr.log"),
    recordPath: join(sessionDir, "process.json"),
    providerPath: join(sessionDir, "provider.json"),
    receiptPublicKey: "fixture-public-key",
    startedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

export class FakeProcessIdentity implements ProcessIdentityPort {
  public constructor(public observed: LiveProcessIdentity | undefined) {}

  public async capture(): Promise<LiveProcessIdentity> {
    if (this.observed === undefined) throw new Error("process missing");
    return this.observed;
  }

  public async inspect(): Promise<LiveProcessIdentity | undefined> {
    return this.observed;
  }

  public async inspectPid(): Promise<LiveProcessIdentity | undefined> {
    return this.observed;
  }
}

export function supervisorFixture(input: {
  readonly observed?: LiveProcessIdentity;
} = {}) {
  const identity = new FakeProcessIdentity(
    input.observed ?? {
      pid: 42,
      startIdentity: "start-old",
      executable: "/managed/bin/pi",
      attemptToken: "token-1",
    },
  );
  const signals: string[] = [];
  const dependencies: PiProcessSupervisorDependencies = {
    identity,
    signalProcess: (_pid, signal) => {
      signals.push(signal);
    },
    sleep: async () => undefined,
    now: () => new Date("2026-09-21T00:00:00.000Z"),
  };
  return {
    supervisor: new NodePiProcessSupervisor(dependencies),
    identity,
    signals,
  };
}

export function piEvent(type: string, payload: Record<string, unknown> = {}) {
  return { type, ...payload };
}
