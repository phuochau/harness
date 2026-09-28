export const taskKinds = ["bugfix", "small-feature", "large-feature"] as const;
export type TaskKind = (typeof taskKinds)[number];

export const RUN_BRIEF_MAX_BYTES = 4096;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEPARATOR = /(?:^|\s)--(?:\s|$)/;

export interface RunRequest {
  readonly runId?: string;
  readonly kind: TaskKind;
  readonly brief?: string;
}

export class RunRequestError extends Error {}

function isTaskKind(value: unknown): value is TaskKind {
  return (
    typeof value === "string" &&
    (taskKinds as readonly string[]).includes(value)
  );
}

function validBrief(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= RUN_BRIEF_MAX_BYTES;
}

export function runRequestFromPayload(
  payload: Readonly<Record<string, unknown>>,
): RunRequest {
  const { target, kind, brief } = payload;
  if (target !== undefined && typeof target !== "string") {
    throw new RunRequestError("run target must be a string");
  }
  if (kind !== undefined && !isTaskKind(kind)) {
    throw new RunRequestError(`unknown task kind: ${String(kind)}`);
  }
  if (
    brief !== undefined &&
    (typeof brief !== "string" || !validBrief(brief))
  ) {
    throw new RunRequestError("run brief must be nonempty and under 4096 bytes");
  }
  const resolvedKind = kind ?? "large-feature";
  if (resolvedKind !== "large-feature" && brief === undefined) {
    throw new RunRequestError(`task kind ${resolvedKind} requires a brief`);
  }
  return {
    ...(target === undefined ? {} : { runId: target }),
    kind: resolvedKind,
    ...(brief === undefined ? {} : { brief }),
  };
}

export function parseRunRequest(args: string): RunRequest {
  const separator = SEPARATOR.exec(args);
  const head = separator === null ? args : args.slice(0, separator.index);
  const briefText = separator === null ? undefined : args.slice(separator.index + separator[0].length);
  const tokens = head.trim() === "" ? [] : head.trim().split(/\s+/);
  const flagged =
    separator !== null || tokens.some((token) => token.startsWith("--"));

  if (!flagged) {
    const runId = args.trim() === "" ? undefined : args.trim();
    return runId === undefined
      ? { kind: "large-feature" }
      : { runId, kind: "large-feature" };
  }

  let index = 0;
  let runId: string | undefined;
  if (tokens.length > 0 && !tokens[0]!.startsWith("--")) {
    runId = tokens[0]!;
    index = 1;
    if (!RUN_ID.test(runId)) {
      throw new RunRequestError(`invalid run id for flagged run: ${runId}`);
    }
  }
  let kind: TaskKind = "large-feature";
  if (index < tokens.length) {
    const flag = tokens[index]!;
    if (flag !== "--kind") {
      throw new RunRequestError(`unknown run flag: ${flag}`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new RunRequestError("--kind requires one of: bugfix, small-feature, large-feature");
    }
    if (!isTaskKind(value)) {
      throw new RunRequestError(
        `unknown task kind ${value}; expected one of: ${taskKinds.join(", ")}`,
      );
    }
    if (tokens.length > index + 2) {
      throw new RunRequestError(`unknown run flag or argument: ${tokens[index + 2]!}`);
    }
    kind = value;
  }

  let brief: string | undefined;
  if (separator !== null) {
    brief = briefText!.trim();
    if (brief === "") {
      throw new RunRequestError("run brief after -- must not be empty");
    }
    if (Buffer.byteLength(brief, "utf8") > RUN_BRIEF_MAX_BYTES) {
      throw new RunRequestError(
        `run brief exceeds ${RUN_BRIEF_MAX_BYTES} bytes`,
      );
    }
  }
  if (kind !== "large-feature" && brief === undefined) {
    throw new RunRequestError(`--kind ${kind} requires a task brief after --`);
  }
  return {
    ...(runId === undefined ? {} : { runId }),
    kind,
    ...(brief === undefined ? {} : { brief }),
  };
}
