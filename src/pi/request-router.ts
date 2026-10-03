import { RUN_BRIEF_MAX_BYTES, taskKinds, type TaskKind } from "./run-request.js";

const readOnlyCommands = ["status", "graph", "task", "logs", "doctor"] as const;
const mutatingCommands = ["retry", "reroute", "cancel", "pause", "resume"] as const;
type OperationalCommand = typeof readOnlyCommands[number] | typeof mutatingCommands[number];

export type RequestDecision =
  | { readonly route: "discuss"; readonly reason?: string }
  | { readonly route: "run"; readonly kind: TaskKind; readonly reason: string }
  | { readonly route: "command"; readonly command: OperationalCommand; readonly target?: string; readonly worker?: string; readonly reason: string };

export interface RequestRouterPorts {
  classify(description: string): Promise<string | undefined>;
  discuss(description: string): void;
  execute(command: string, args: string): Promise<void>;
  notify(message: string): void;
  confirm(title: string, detail: string): Promise<boolean>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function safeReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240;
}

function safeTarget(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function parseRequestDecision(raw: string): RequestDecision | undefined {
  if (raw.length > 4096) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.route === "discuss") {
    if (!exactKeys(record, ["route", "reason"])) return undefined;
    if (record.reason !== undefined && !safeReason(record.reason)) return undefined;
    return { route: "discuss", ...(record.reason === undefined ? {} : { reason: record.reason as string }) };
  }
  if (record.route === "run") {
    if (!exactKeys(record, ["route", "kind", "reason"])) return undefined;
    if (!taskKinds.includes(record.kind as TaskKind) || !safeReason(record.reason)) return undefined;
    return { route: "run", kind: record.kind as TaskKind, reason: record.reason };
  }
  if (record.route === "command") {
    if (!exactKeys(record, ["route", "command", "target", "worker", "reason"])) return undefined;
    if (![...readOnlyCommands, ...mutatingCommands].includes(record.command as OperationalCommand)
      || !safeReason(record.reason)) return undefined;
    if (record.target !== undefined && !safeTarget(record.target)) return undefined;
    if (record.worker !== undefined && !safeTarget(record.worker)) return undefined;
    return {
      route: "command",
      command: record.command as OperationalCommand,
      ...(record.target === undefined ? {} : { target: record.target as string }),
      ...(record.worker === undefined ? {} : { worker: record.worker as string }),
      reason: record.reason,
    };
  }
  return undefined;
}

export async function routeHarnessRequest(
  description: string,
  ports: RequestRouterPorts,
): Promise<void> {
  const brief = description.trim();
  if (!brief || Buffer.byteLength(brief, "utf8") > RUN_BRIEF_MAX_BYTES) {
    throw new Error(`request description must be nonempty and at most ${RUN_BRIEF_MAX_BYTES} bytes`);
  }
  let decision: RequestDecision | undefined;
  try {
    const answer = await ports.classify(brief);
    decision = answer === undefined ? undefined : parseRequestDecision(answer);
  } catch {
    decision = undefined;
  }
  if (decision === undefined || decision.route === "discuss") {
    ports.discuss(brief);
    return;
  }
  if (decision.route === "run") {
    ports.notify(`Suggested ${decision.kind}: ${decision.reason}`);
    await ports.execute("harness:run", `--kind ${decision.kind} -- ${brief}`);
    return;
  }
  const { command, target, worker } = decision;
  if ((["task", "retry", "reroute", "cancel"] as readonly string[]).includes(command) && !target) {
    ports.discuss(brief);
    return;
  }
  if (command === "reroute" && !worker) {
    ports.discuss(brief);
    return;
  }
  if (mutatingCommands.includes(command as typeof mutatingCommands[number])) {
    if (!(await ports.confirm(`Run harness:${command}?`, `${decision.reason}\nTarget: ${target ?? "run"}`))) return;
  }
  await ports.execute(`harness:${command}`, command === "reroute" ? `${target} ${worker}` : target ?? "");
}
