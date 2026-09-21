import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { Type, type Static, type TSchema } from "typebox";

export const HashSchema = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
export const VersionSchema = Type.Literal(1);
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema = Type.Unsafe<JsonValue>({
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: {} },
    { type: "object", additionalProperties: {} },
  ],
});

const ajv = new AjvModule.default({ allErrors: true, strict: true });
addFormatsModule.default(ajv);

export function validator<T extends TSchema>(
  schema: T,
): (value: unknown) => Static<T> {
  const check = ajv.compile(schema);
  return (value): Static<T> => {
    assertJsonCompatible(value);
    if (!check(value)) {
      throw new Error(ajv.errorsText(check.errors));
    }
    return value as Static<T>;
  };
}

function assertJsonCompatible(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("durable JSON numbers must be finite");
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`durable values must be JSON-compatible, received ${typeof value}`);
  }
  if (seen.has(value)) throw new Error("durable JSON values cannot be cyclic");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonCompatible(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("durable JSON objects must be plain objects");
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertJsonCompatible(item, seen);
    }
  }
  seen.delete(value);
}
