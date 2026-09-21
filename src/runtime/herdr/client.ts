import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Ajv2020Module from "ajv/dist/2020.js";
import {
  HERDR_PROTOCOL_SCHEMA,
  type HerdrMethod,
} from "./protocol.generated.js";
import {
  NewlineSocketHerdrTransport,
  type HerdrTransport,
  type HerdrWireRequest,
} from "./transport.js";

export interface HerdrWorkspace {
  readonly workspace_id: string;
  readonly cwd?: string | null;
  readonly label?: string | null;
  readonly [key: string]: unknown;
}

export interface HerdrPane {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly [key: string]: unknown;
}

export interface HerdrAgent {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  readonly agent?: string | null;
  readonly name?: string | null;
  readonly [key: string]: unknown;
}

interface KnownHerdrMethods {
  readonly "workspace.list": {
    readonly params: Record<string, never>;
    readonly result: { readonly type: "workspace_list"; readonly workspaces: readonly HerdrWorkspace[] };
  };
  readonly "workspace.create": {
    readonly params: {
      readonly cwd?: string | null;
      readonly label?: string | null;
      readonly focus?: boolean;
      readonly env?: Readonly<Record<string, string>>;
    };
    readonly result: {
      readonly type: "workspace_created";
      readonly workspace: HerdrWorkspace;
      readonly root_pane: HerdrPane;
      readonly tab: Readonly<Record<string, unknown>>;
    };
  };
  readonly "workspace.close": {
    readonly params: { readonly workspace_id: string; readonly close_group?: boolean };
    readonly result: Readonly<Record<string, unknown>>;
  };
  readonly "agent.list": {
    readonly params: Record<string, unknown>;
    readonly result: { readonly type: "agent_list"; readonly agents: readonly HerdrAgent[] };
  };
  readonly "agent.get": {
    readonly params: { readonly target: string };
    readonly result: { readonly type: "agent_info"; readonly agent: HerdrAgent };
  };
  readonly "agent.start": {
    readonly params: {
      readonly name: string;
      readonly kind: string;
      readonly pane_id: string;
      readonly args?: readonly string[];
      readonly timeout_ms?: number | null;
    };
    readonly result: { readonly type: "agent_started"; readonly agent: HerdrAgent; readonly argv: readonly string[] };
  };
  readonly "agent.prompt": {
    readonly params: { readonly target: string; readonly text: string; readonly wait?: unknown };
    readonly result: { readonly type: "agent_prompted"; readonly agent: HerdrAgent };
  };
  readonly "agent.wait": {
    readonly params: { readonly target: string; readonly until?: readonly string[]; readonly timeout_ms?: number | null };
    readonly result: Readonly<Record<string, unknown>>;
  };
  readonly "agent.read": {
    readonly params: { readonly target: string; readonly source: string; readonly lines?: number | null; readonly format?: string };
    readonly result: Readonly<Record<string, unknown>>;
  };
  readonly "events.subscribe": {
    readonly params: { readonly subscriptions: readonly Readonly<Record<string, unknown>>[] };
    readonly result: Readonly<Record<string, unknown>>;
  };
}

export type HerdrParams<M extends HerdrMethod> = M extends keyof KnownHerdrMethods
  ? KnownHerdrMethods[M]["params"]
  : Readonly<Record<string, unknown>>;

export type HerdrResult<M extends HerdrMethod> = M extends keyof KnownHerdrMethods
  ? KnownHerdrMethods[M]["result"]
  : Readonly<Record<string, unknown>>;

export interface HerdrEvent {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export class HerdrProtocolError extends Error {}

export class HerdrRemoteError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`Herdr ${code}: ${message}`);
  }
}

const schema = structuredClone(HERDR_PROTOCOL_SCHEMA) as Record<string, unknown>;
schema.$id = "urn:pi-harness:herdr-protocol";
const ajv = new Ajv2020Module.default({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
ajv.addSchema(schema);

function schemaValidator(fragment: string) {
  const validator = ajv.getSchema(`urn:pi-harness:herdr-protocol${fragment}`);
  if (validator === undefined) {
    throw new Error(`generated Herdr schema is missing ${fragment}`);
  }
  return validator;
}

const requestValidator = schemaValidator("#/schemas/request");
const successValidator = schemaValidator("#/schemas/success_response");
const errorValidator = schemaValidator("#/schemas/error_response");
const eventValidator = schemaValidator("#/schemas/event");
const subscriptionEventValidator = schemaValidator("#/schemas/subscription_event");

function validationMessage(): string {
  return ajv.errorsText(
    requestValidator.errors ??
      successValidator.errors ??
      errorValidator.errors ??
      eventValidator.errors ??
      subscriptionEventValidator.errors,
  );
}

export function validateHerdrRequest(value: unknown): HerdrWireRequest {
  if (!requestValidator(value)) {
    throw new HerdrProtocolError(`invalid Herdr request: ${validationMessage()}`);
  }
  return value as HerdrWireRequest;
}

function validateEvent(value: unknown): HerdrEvent {
  if (!eventValidator(value) && !subscriptionEventValidator(value)) {
    throw new HerdrProtocolError(`invalid Herdr event: ${validationMessage()}`);
  }
  return value as HerdrEvent;
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HerdrProtocolError("Herdr response is not an object");
  }
  return value as Record<string, unknown>;
}

export class HerdrClient {
  private sequence = 0;
  private readonly listeners = new Set<(event: HerdrEvent) => void>();
  private readonly unsubscribeTransport: () => void;

  public constructor(private readonly transport: HerdrTransport) {
    this.unsubscribeTransport = transport.subscribe((frame) => {
      const event = validateEvent(frame);
      for (const listener of this.listeners) listener(event);
    });
  }

  public async request<M extends HerdrMethod>(
    method: M,
    params: HerdrParams<M>,
  ): Promise<HerdrResult<M>> {
    const id = `harness-${++this.sequence}`;
    const request = validateHerdrRequest({ id, method, params });
    const raw = await this.transport.request(request);
    const frame = responseObject(raw);
    if (frame.id !== id) {
      throw new HerdrProtocolError(
        `Herdr response correlation mismatch: expected ${id}, received ${String(frame.id)}`,
      );
    }
    if (errorValidator(raw)) {
      const error = frame.error as { code: string; message: string };
      throw new HerdrRemoteError(error.code, error.message);
    }
    if (!successValidator(raw)) {
      throw new HerdrProtocolError(`invalid Herdr response: ${validationMessage()}`);
    }
    return frame.result as HerdrResult<M>;
  }

  public subscribe(listener: (event: HerdrEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): void {
    this.unsubscribeTransport();
    this.listeners.clear();
    this.transport.close();
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function installedHerdrSchemaHash(): Promise<string> {
  const { stdout } = await promisify(execFile)("herdr", ["api", "schema", "--json"], {
    encoding: "utf8",
  });
  return `sha256:${createHash("sha256")
    .update(canonicalJson(JSON.parse(stdout)))
    .digest("hex")}`;
}

function installedSocketPath(): string {
  const explicit = process.env.HERDR_SOCKET_PATH;
  if (explicit !== undefined && explicit !== "") return explicit;
  if (process.platform === "win32") {
    throw new HerdrProtocolError(
      "HARNESS_COMPAT_HERDR on Windows requires HERDR_SOCKET_PATH",
    );
  }
  const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const session = process.env.HERDR_SESSION;
  return session === undefined || session === ""
    ? join(configRoot, "herdr", "herdr.sock")
    : join(configRoot, "herdr", "sessions", session, "herdr.sock");
}

export async function connectInstalledHerdr(): Promise<HerdrClient> {
  return new HerdrClient(
    await NewlineSocketHerdrTransport.connect(installedSocketPath()),
  );
}
