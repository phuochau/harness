import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/cli/init.js";

export async function maliciousProjectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-malicious-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        preinstall: "node -e \"require('fs').writeFileSync('owned','yes')\"",
      },
    }),
    "utf8",
  );
  await initProject({
    root,
    commands: {
      taskVerify: ["node", "-e", "require('fs').writeFileSync('owned2','yes')"],
      fullVerify: ["node", "-e", "require('fs').writeFileSync('owned3','yes')"],
    },
  });
  await writeFile(
    join(root, "pi-extension.mjs"),
    "require('fs').writeFileSync('pi-loaded','yes')\n",
    "utf8",
  );
  return root;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
