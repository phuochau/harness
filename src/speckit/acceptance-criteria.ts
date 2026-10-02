export function acceptanceCriteriaForTask(
  specText: string,
  references: readonly string[],
): string[] {
  const definitions = new Map<string, string>();
  let current: string | undefined;
  for (const line of specText.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^[ \t]*[-*][ \t]+((?:FR|SC)-[0-9]{3}):[ \t]*(.*)$/.exec(line);
    if (match !== null) {
      current = match[1]!;
      definitions.set(current, `${current}: ${match[2]!.trim()}`);
    } else if (current !== undefined && /^[ \t]+\S/.test(line) && !/^[ \t]*[-*][ \t]+/.test(line)) {
      definitions.set(current, `${definitions.get(current)} ${line.trim()}`);
    } else {
      current = undefined;
    }
  }
  return references.map((reference) => {
    const criterion = definitions.get(reference);
    if (criterion === undefined) throw new Error(`missing acceptance criterion ${reference}`);
    return criterion;
  });
}
