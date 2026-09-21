export const harnessIgnoreBlock = [
  "# BEGIN pi-multi-agent-harness",
  ".pi/npm/",
  ".pi/git/",
  ".harness-output/",
  "# END pi-multi-agent-harness",
].join("\n");

const blockPattern =
  /(?:^|\n)# BEGIN pi-multi-agent-harness\n[\s\S]*?\n# END pi-multi-agent-harness(?=\n|$)/g;

export function mergeHarnessIgnore(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n");
  const withoutManaged = normalized.replace(blockPattern, "\n").replace(/\n{3,}/g, "\n\n");
  const prefix = withoutManaged.trimEnd();
  return `${prefix === "" ? "" : `${prefix}\n\n`}${harnessIgnoreBlock}\n`;
}
