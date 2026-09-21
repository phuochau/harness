const commandReference = /^\$\{commands\.([a-z][a-z0-9_]*)\}$/;

export function resolveReferences(
  value: unknown,
  commands: Readonly<Record<string, readonly string[]>>,
): unknown {
  if (typeof value === "string") {
    const match = commandReference.exec(value);
    if (match) {
      const name = match[1];
      const command = name === undefined ? undefined : commands[name];
      if (!command) throw new Error(`unknown command reference: ${name}`);
      return [...command];
    }
    if (value.includes("${")) {
      throw new Error(`references must occupy a complete scalar: ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, commands));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReferences(item, commands),
      ]),
    );
  }
  return value;
}
