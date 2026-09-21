import { deepFreeze } from "../../src/shared/deep-freeze.js";

export type DeepPartial<T> = T extends readonly (infer Item)[]
  ? DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

export function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return structuredClone(overrides ?? base) as T;
  }
  if (
    !base ||
    typeof base !== "object" ||
    !overrides ||
    typeof overrides !== "object"
  ) {
    return structuredClone(overrides ?? base) as T;
  }
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = deepMerge(result[key], value);
    }
  }
  return result as T;
}

export function fixture<T>(base: () => T): (overrides?: DeepPartial<T>) => T {
  return (overrides = {} as DeepPartial<T>) =>
    deepFreeze(deepMerge(base(), overrides)) as T;
}
