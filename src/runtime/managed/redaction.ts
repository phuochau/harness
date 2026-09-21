function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactDiagnostic(
  value: string,
  secretNames: readonly string[] = [],
): string {
  let redacted = value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|password|secret|authorization)=\S+/gi, "$1=[REDACTED]")
    .replace(/:\/\/[^/@\s]+@/g, "://[REDACTED]@");
  for (const name of [...new Set(secretNames)].sort((a, b) => b.length - a.length)) {
    if (name === "") continue;
    redacted = redacted.replace(
      new RegExp(`\\b${escapeRegExp(name)}=\\S+`, "g"),
      `${name}=[REDACTED]`,
    );
  }
  return redacted;
}
