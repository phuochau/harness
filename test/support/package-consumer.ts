import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execa } from "execa";

export interface PackedHarness {
  readonly tarball: string;
  readonly files: readonly string[];
  cleanup(): Promise<void>;
}

export interface PackageConsumer {
  readonly root: string;
  exec(command: string, argv: readonly string[]): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  loadWithPiResourceLoader(): Promise<{ readonly errors: readonly unknown[] }>;
  loadPublicEntrypoint(): Promise<void>;
  cleanup(): Promise<void>;
}

async function run(
  executable: string,
  argv: readonly string[],
  cwd: string,
) {
  const result = await execa(executable, [...argv], { cwd, reject: false });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function packHarness(): Promise<PackedHarness> {
  const root = resolve(".");
  const directory = await mkdtemp(join(tmpdir(), "harness-pack-"));
  const build = await run("npm", ["run", "build"], root);
  if (build.exitCode !== 0) throw new Error(build.stderr || build.stdout);
  const packed = await run(
    "npm",
    ["pack", "--json", "--pack-destination", directory],
    root,
  );
  if (packed.exitCode !== 0) throw new Error(packed.stderr || packed.stdout);
  const record = JSON.parse(packed.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const first = record[0];
  if (first === undefined) throw new Error("npm pack returned no package");
  return {
    tarball: join(directory, basename(first.filename)),
    files: first.files.map((item) => item.path),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function installPackedHarness(
  packed: PackedHarness,
  peers: { readonly pi: string; readonly typebox: string },
): Promise<PackageConsumer> {
  const root = await mkdtemp(join(tmpdir(), "harness-consumer-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "harness-consumer", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  const installed = await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      packed.tarball,
      `@earendil-works/pi-coding-agent@${peers.pi}`,
      `typebox@${peers.typebox}`,
    ],
    root,
  );
  if (installed.exitCode !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error(installed.stderr || installed.stdout);
  }
  return {
    root,
    exec: (command, argv) => run(join(root, "node_modules/.bin", command), argv, root),
    async loadWithPiResourceLoader() {
      const script = [
        "import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';",
        "import { join } from 'node:path';",
        "const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: join(process.cwd(), 'agent'), additionalExtensionPaths: [join(process.cwd(), 'node_modules/pi-multi-agent-harness/dist/pi/extension.js')], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });",
        "await loader.reload();",
        "process.stdout.write(JSON.stringify({ errors: loader.getExtensions().errors }));",
      ].join("\n");
      const result = await run(process.execPath, ["--input-type=module", "--eval", script], root);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
      return JSON.parse(result.stdout) as { errors: readonly unknown[] };
    },
    async loadPublicEntrypoint() {
      const result = await run(
        process.execPath,
        ["--input-type=module", "--eval", "await import('pi-multi-agent-harness')"],
        root,
      );
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
