import { Command } from "commander";
import { join } from "node:path";
import { bootstrap } from "./bootstrap.js";
import { parseArgvJson } from "./command-detection.js";
import { doctor } from "./doctor.js";
import { initProject } from "./init.js";
import { builtInBaseline } from "../install/baseline-policy.js";
import { probeEnvironment } from "../install/probes.js";
import { ReceiptStore } from "../install/receipts.js";
import type { CapabilityReport, ExecutableCapability } from "../install/types.js";
import type { TrustedSource } from "../install/types.js";
import { OFFICIAL_NPM_REGISTRY } from "../install/recipes.js";
import { NodeProcessRunner } from "../git/process.js";
import type { DeclarativeProject } from "./trusted-project-reader.js";
import { connectInstalledHerdr } from "../runtime/herdr/client.js";
import { explain } from "./explain.js";
import { graph } from "./graph.js";
import { installedStartDependencies, start } from "./start.js";
import { status } from "./status.js";

function semver(stdout: string): string | undefined {
  return /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(stdout)?.[1];
}

function npmVersion(packageName: string, stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      dependencies?: Record<string, { version?: unknown }>;
    };
    const version = parsed.dependencies?.[packageName]?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function executableCapabilities(project: DeclarativeProject): readonly ExecutableCapability[] {
  const result: ExecutableCapability[] = [
    { id: "node", command: process.execPath, versionArgs: ["--version"], parseVersion: semver },
    { id: "git", command: "git", versionArgs: ["--version"], parseVersion: semver },
    {
      id: "github-cli",
      command: "gh",
      versionArgs: ["--version"],
      parseVersion: semver,
      auth: { args: ["auth", "status"], isAuthenticated: (_stdout, stderr) => !/not logged/i.test(stderr) },
    },
  ];
  const commands: Readonly<Record<string, string>> = {
    "pi-coding-agent": "pi",
    "spec-kit": "specify",
    herdr: "herdr",
    codex: "codex",
    devin: "devin",
    claude: "claude",
  };
  const auth: Readonly<Record<string, ExecutableCapability["auth"]>> = {
    "pi-coding-agent": {
      args: ["auth", "check", "--provider", "openai-codex", "--json", "--no-refresh"],
      isAuthenticated: (stdout) => {
        try {
          return (JSON.parse(stdout) as { status?: unknown }).status === "ready";
        } catch {
          return false;
        }
      },
    },
    codex: {
      args: ["login", "status"],
      isAuthenticated: (stdout, stderr) => /logged in/i.test(`${stdout}\n${stderr}`),
    },
    devin: {
      args: ["auth", "status"],
      isAuthenticated: (stdout, stderr) => /logged in/i.test(`${stdout}\n${stderr}`),
    },
    claude: {
      args: ["auth", "status"],
      isAuthenticated: (stdout) => {
        try {
          return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
        } catch {
          return /logged in/i.test(stdout) && !/not logged in/i.test(stdout);
        }
      },
    },
  };
  for (const dependency of project.lock.dependencies) {
    if (dependency.id === "typebox") {
      result.push({
        id: dependency.id,
        command: "npm",
        versionArgs: ["list", "--global", "--json", "--depth=0", dependency.source.identity],
        expectedVersion: dependency.version,
        parseVersion: (stdout) => npmVersion(dependency.source.identity, stdout),
      });
      continue;
    }
    const command = commands[dependency.id];
    if (command !== undefined) {
      const authConfig = auth[dependency.id];
      result.push({
        id: dependency.id,
        command,
        versionArgs: ["--version"],
        expectedVersion: dependency.version,
        parseVersion: semver,
        ...(authConfig === undefined ? {} : { auth: authConfig }),
      });
    }
  }
  return result;
}

async function defaultProbe(
  project: DeclarativeProject,
  processRunner: NodeProcessRunner,
): Promise<CapabilityReport> {
  const report = await probeEnvironment({
    root: project.root,
    process: processRunner,
    capabilities: executableCapabilities(project),
  });
  const byId = { ...report.byId };
  for (const requirement of project.environment.pi_packages) {
    const result = byId[`pi-package:${requirement.id}`];
    if (result !== undefined) byId[requirement.dependency] = result;
  }
  const planningAuth = byId["auth:pi-coding-agent"];
  byId["planning-profile:chatgpt"] = {
    id: "planning-profile:chatgpt",
    status: planningAuth?.status === "present" ? "present" : "unverifiable",
    ...(planningAuth?.status === "present"
      ? {}
      : { evidence: ["Pi openai-codex credential readiness was not proven"] }),
  };
  return { byId };
}

async function npmRegistryIntegrity(
  processRunner: NodeProcessRunner,
  source: { identity: string; version: string },
): Promise<string | undefined> {
  if (
    "registry" in source &&
    (source as { registry?: unknown }).registry !== OFFICIAL_NPM_REGISTRY
  ) {
    throw new Error("npm source is not bound to the official registry");
  }
  const result = await processRunner.run(
    "npm",
    [
      "view",
      `${source.identity}@${source.version}`,
      "dist.integrity",
      "--json",
      `--registry=${OFFICIAL_NPM_REGISTRY}`,
    ],
    { shell: false, timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    const value = result.stdout.trim();
    return value === "" ? undefined : value;
  }
}

async function resolveRegistrySource(
  processRunner: NodeProcessRunner,
  source: TrustedSource,
): Promise<TrustedSource> {
  if (source.kind !== "npm" || source.integrity !== "npm-registry:dist.integrity") {
    return source;
  }
  const integrity = await npmRegistryIntegrity(processRunner, source);
  if (integrity === undefined || !integrity.startsWith("sha512-")) {
    throw new Error(`npm registry did not return a sha512 integrity for ${source.identity}`);
  }
  return { ...source, registry: OFFICIAL_NPM_REGISTRY, integrity };
}

async function verifyNpmIntegrity(
  processRunner: NodeProcessRunner,
  source: {
    kind: string;
    identity: string;
    version: string;
    integrity: string;
    registry?: string;
  },
): Promise<boolean> {
  if (source.kind !== "npm" || !source.integrity.startsWith("sha512-")) return false;
  if (source.registry !== OFFICIAL_NPM_REGISTRY) return false;
  return await npmRegistryIntegrity(processRunner, source) === source.integrity;
}

async function verifyPiResourcesInChild(
  processRunner: NodeProcessRunner,
  root: string,
  scope: "project" | "global",
): Promise<boolean> {
  if (scope !== "project") return true;
  const script = [
    "import { mkdir } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';",
    "const root = process.argv[1];",
    "const agentDir = join(root, '.harness/runtime/pi-agent');",
    "await mkdir(agentDir, { recursive: true });",
    "const loader = new DefaultResourceLoader({ cwd: root, agentDir, noContextFiles: true });",
    "await loader.reload({ resolveProjectTrust: async () => true });",
    "const diagnostics = [loader.getExtensions().errors, loader.getSkills().diagnostics, loader.getPrompts().diagnostics, loader.getThemes().diagnostics].flat();",
    "if (diagnostics.length > 0) process.exitCode = 1;",
  ].join("\n");
  const path = process.env.PATH;
  const home = process.env.HOME;
  const result = await processRunner.run(
    process.execPath,
    ["--input-type=module", "--eval", script, root],
    {
      cwd: root,
      env: {
        ...(path === undefined ? {} : { PATH: path }),
        ...(home === undefined ? {} : { HOME: home }),
      },
      shell: false,
      timeoutMs: 30_000,
    },
  );
  return result.exitCode === 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const program = new Command()
    .name("harness")
    .description("Pi multi-agent orchestrator");
  program.command("version").action(() => {
    process.stdout.write("0.1.0\n");
  });
  program
    .command("init [path]")
    .description("Create an editable runnable harness workflow")
    .option("--task-verify <argv-json>", "task verification command as a JSON argv array")
    .option("--full-verify <argv-json>", "full verification command as a JSON argv array")
    .action(
      async (
        path: string | undefined,
        flags: { taskVerify?: string; fullVerify?: string },
      ) => {
        const hasTask = flags.taskVerify !== undefined;
        const hasFull = flags.fullVerify !== undefined;
        if (hasTask !== hasFull) {
          throw new Error("pass both --task-verify and --full-verify");
        }
        await initProject({
          root: path ?? ".",
          ...(!hasTask || !hasFull
            ? {}
            : {
                commands: {
                  taskVerify: parseArgvJson(flags.taskVerify!, "--task-verify"),
                  fullVerify: parseArgvJson(flags.fullVerify!, "--full-verify"),
                },
              }),
        });
      },
    );
  program
    .command("bootstrap [path]")
    .description("Probe and install exact locked harness dependencies")
    .option("--dry-run", "show the content-addressed plan without executing it")
    .option("--repair", "repair a customized declared Pi package entry")
    .option("--yes", "approve the exact generated plan non-interactively")
    .action(async (path: string | undefined, flags: { dryRun?: boolean; repair?: boolean; yes?: boolean }) => {
      const root = path ?? ".";
      const processRunner = new NodeProcessRunner();
      const result = await bootstrap(
        {
          root,
          ...(flags.dryRun === undefined ? {} : { dryRun: flags.dryRun }),
          ...(flags.repair === undefined ? {} : { repair: flags.repair }),
          ...(flags.yes === undefined ? {} : { yes: flags.yes }),
        },
        {
          baseline: builtInBaseline(),
          probe: (project) => defaultProbe(project, processRunner),
          resolveSource: (source) => resolveRegistrySource(processRunner, source),
          presenter: {
            async show(plan) {
              process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
            },
          },
          approvals: {
            async requirePlanHash(planHash, yes) {
              return { approved: yes, planHash };
            },
          },
          executor: {
            process: processRunner,
            receipts: new ReceiptStore(join(root, ".harness/install-receipts.jsonl")),
            verifySource: (step) => verifyNpmIntegrity(processRunner, step.source),
            verifyLoaded: (step) => verifyPiResourcesInChild(processRunner, root, step.scope),
          },
        },
      );
      if (result.status === "installed") {
        process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
      }
    });
  program
    .command("doctor [path]")
    .description("Freshly probe harness capabilities")
    .option("--json", "emit the schema-versioned JSON report")
    .action(async (path: string | undefined, flags: { json?: boolean }) => {
      const processRunner = new NodeProcessRunner();
      const report = await doctor(
        { root: path ?? "." },
        { probe: (project) => defaultProbe(project, processRunner) },
      );
      if (flags.json === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${report.ok ? "ready" : "not ready"}\n`);
        for (const capability of report.capabilities) {
          process.stdout.write(`${capability.id}: ${capability.status}\n`);
        }
      }
    });
  program
    .command("start [path]")
    .description("Start or reattach the dedicated Pi controller in Herdr")
    .action(async (path: string | undefined) => {
      const client = await connectInstalledHerdr();
      try {
        const processRunner = new NodeProcessRunner();
        const result = await start(
          { root: path ?? "." },
          installedStartDependencies(processRunner, client),
        );
        process.stdout.write(`${result.mode}: ${result.agent.name}\n`);
      } finally {
        client.close();
      }
    });
  program
    .command("status <run-id> [path]")
    .description("Read the durable status of a run")
    .action(async (runId: string, path: string | undefined) => {
      process.stdout.write(`${JSON.stringify(await status({ root: path ?? ".", runId }), null, 2)}\n`);
    });
  program
    .command("graph <run-id> [path]")
    .description("Read the materialized run graph state")
    .action(async (runId: string, path: string | undefined) => {
      process.stdout.write(`${JSON.stringify(await graph({ root: path ?? ".", runId }), null, 2)}\n`);
    });
  program
    .command("explain <run-id> <target> [path]")
    .description("Read the durable event history for one run entity or effect")
    .action(async (runId: string, target: string, path: string | undefined) => {
      process.stdout.write(
        `${JSON.stringify(await explain({ root: path ?? ".", runId, target }), null, 2)}\n`,
      );
    });
  program
    .command("recover <run-id> [path]")
    .description("Reconcile a run using installed production action adapters")
    .action(async (_runId: string, _path: string | undefined) => {
      throw new Error(
        "standalone recovery is unavailable until production action adapters are connected; journal was not modified",
      );
    });
  await program.parseAsync([...argv], { from: "user" });
  return 0;
}
