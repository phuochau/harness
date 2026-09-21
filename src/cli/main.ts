import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
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
import { explain } from "./explain.js";
import { graph } from "./graph.js";
import { status } from "./status.js";
import { recover } from "./recover.js";
import { createStandaloneProductionEffects } from "../runtime/production/system.js";
import { createManagedPiRuntimeFromResolved } from "../runtime/managed/factory.js";
import type { JsonValue } from "../contracts/common.js";
import { createWorkflowLifecycle } from "../core/workflow-lifecycle.js";
import { managedRuntimePaths } from "../runtime/managed/paths.js";
import { authCommand, runInteractive } from "./auth.js";
import { findPackageRoot } from "./package-root.js";
import { readDeclarativeProject, readTrustedHarnessLock } from "./trusted-project-reader.js";
import { buildManagedEnvironment } from "../runtime/managed/environment.js";
import { projectLocalSubscriptionCredentials } from "../runtime/managed/credentials.js";
import type { ResolvedProfile } from "../config/profiles.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { sha256 } from "../shared/sha256.js";
import { resolveRunPaths } from "../state/paths.js";
import { readResolvedRunConfig } from "../state/resolved-run-config.js";

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

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentPluginCapabilityId(id: string): string {
  return `agent-plugin:${id}`;
}

function declaredAgentPlugins(project: DeclarativeProject) {
  return project.environment.agent_plugins ?? [];
}

export function executableCapabilities(
  project: DeclarativeProject,
): readonly ExecutableCapability[] {
  const managed = managedRuntimePaths({
    dataHome: process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    runtimeVersion: project.lock.harnessVersion,
    profileId: "planner-codex",
  });
  const result: ExecutableCapability[] = [
    {
      id: "node",
      command: process.execPath,
      versionArgs: ["--version"],
      expectedVersion: ">=22.22.2",
      parseVersion: semver,
    },
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
    "pi-coding-agent": join(managed.packages, "node_modules", ".bin", "pi"),
    "spec-kit": "specify",
    codex: "codex",
    devin: "devin",
    claude: "claude",
  };
  const auth: Readonly<Record<string, ExecutableCapability["auth"]>> = {
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
  const superpowersVersion = project.lock.dependencies.find(
    (dependency) => dependency.id === "superpowers",
  )?.version;
  if (superpowersVersion !== undefined) {
    const declared = declaredAgentPlugins(project).filter(
      (plugin) => plugin.dependency === "superpowers",
    );
    const codexRequirement = declared.find((plugin) => plugin.agent === "codex");
    const codexPlugin = join(
      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "plugins",
      "cache",
      ...(codexRequirement?.plugin_id.split("/") ?? ["superpowers-dev", "superpowers"]),
      superpowersVersion,
      ".codex-plugin",
      "plugin.json",
    );
    const probes: readonly ExecutableCapability[] = declared.map((requirement) => {
      if (requirement.agent === "pi") return {
        id: agentPluginCapabilityId(requirement.id),
        command: "pi",
        versionArgs: ["list", "--no-approve"],
        expectedVersion: superpowersVersion,
        parseVersion: (stdout) =>
          new RegExp(
            `[\\\\/]${regexLiteral(requirement.plugin_id)}[\\\\/]${regexLiteral(superpowersVersion)}(?:[\\\\/]|\\s|$)`,
          ).test(stdout)
            ? superpowersVersion
            : undefined,
      };
      if (requirement.agent === "codex") return {
        id: agentPluginCapabilityId(requirement.id),
        command: process.execPath,
        versionArgs: [
          "--input-type=module",
          "--eval",
          `import { readFile } from "node:fs/promises"; const value = JSON.parse(await readFile(${JSON.stringify(codexPlugin)}, "utf8")); if (value.version !== ${JSON.stringify(superpowersVersion)}) process.exit(1); console.log(value.version);`,
        ],
        expectedVersion: superpowersVersion,
        parseVersion: (stdout) => stdout.trim() || undefined,
      };
      if (requirement.agent === "devin") return {
        id: agentPluginCapabilityId(requirement.id),
        command: "devin",
        versionArgs: ["plugins", "list"],
        expectedVersion: superpowersVersion,
        parseVersion: (stdout) =>
          new RegExp(`${regexLiteral(requirement.plugin_id)}\\s+v${regexLiteral(superpowersVersion)}(?:\\s|$)`).test(stdout)
            ? superpowersVersion
            : undefined,
      };
      return {
        id: agentPluginCapabilityId(requirement.id),
        command: "claude",
        versionArgs: ["plugin", "list", "--json"],
        expectedVersion: superpowersVersion,
        parseVersion: (stdout) => {
          try {
            const plugins = JSON.parse(stdout) as readonly {
              id?: unknown;
              version?: unknown;
              enabled?: unknown;
            }[];
            return plugins.some(
              (plugin) =>
                plugin.id === requirement.plugin_id &&
                plugin.version === superpowersVersion &&
                plugin.enabled === true,
            )
              ? superpowersVersion
              : undefined;
          } catch {
            return undefined;
          }
        },
      };
    });
    result.push(...probes);
  }
  return result;
}

export async function defaultProbe(
  project: DeclarativeProject,
  processRunner: NodeProcessRunner,
): Promise<CapabilityReport> {
  const report = await probeEnvironment({
    root: project.root,
    managedPackagesRoot: managedRuntimePaths({
      dataHome: process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      runtimeVersion: project.lock.harnessVersion,
      profileId: "planner-codex",
    }).packages,
    process: processRunner,
    capabilities: executableCapabilities(project),
  });
  const byId = { ...report.byId };
  for (const requirement of project.environment.pi_packages) {
    const result = byId[`pi-package:${requirement.id}`];
    if (result !== undefined) byId[requirement.dependency] = result;
  }
  const planningAuth = byId["auth:codex"];
  byId["planning-profile:chatgpt"] = {
    id: "planning-profile:chatgpt",
    status: planningAuth?.status === "present" ? "present" : "unverifiable",
    ...(planningAuth?.status === "present"
      ? {}
      : { evidence: ["Codex CLI subscription readiness was not proven"] }),
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
  scope: "project" | "managed" | "global",
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

export interface MainDependencies {
  readonly createManagedRuntimeFromResolved?: typeof createManagedPiRuntimeFromResolved;
  readonly createStandaloneEffects?: typeof createStandaloneProductionEffects;
}

export async function main(
  argv: readonly string[],
  dependencies: MainDependencies = {},
): Promise<number> {
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
  const installAction = async (
    path: string | undefined,
    flags: { dryRun?: boolean; repair?: boolean; yes?: boolean },
  ) => {
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
    };
  const configureInstall = (command: Command) => command
    .description("Probe and install exact locked harness dependencies")
    .option("--dry-run", "show the content-addressed plan without executing it")
    .option("--repair", "repair a customized declared Pi package entry")
    .option("--yes", "approve the exact generated plan non-interactively")
    .action(installAction);
  configureInstall(program.command("setup [path]"));
  configureInstall(program.command("bootstrap [path]").description("Compatibility alias for setup"));
  program
    .command("auth <profile> [path]")
    .description("Authenticate one isolated managed Pi profile using subscription login")
    .option("--reuse-local", "explicitly copy the allowlisted local CLI subscription credential")
    .action(async (
      profileId: string,
      path: string | undefined,
      flags: { reuseLocal?: boolean },
    ) => {
      const root = path ?? ".";
      const project = await readDeclarativeProject(root);
      const declared = project.profiles.profiles[profileId];
      if (declared === undefined) throw new Error(`unknown profile ${profileId}`);
      const profile = {
        id: profileId,
        ...declared,
        extensions: [],
        skills: [],
        promptTemplates: [],
        contextFiles: false,
        mcp: [],
        hash: sha256(canonicalJson({ id: profileId, declared })),
      } as unknown as ResolvedProfile;
      const paths = managedRuntimePaths({
        dataHome: process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
        runtimeVersion: project.lock.harnessVersion,
        profileId,
      });
      await Promise.all([
        mkdir(paths.profileHome, { recursive: true, mode: 0o700 }),
        mkdir(paths.piAgentDir, { recursive: true, mode: 0o700 }),
        mkdir(paths.xdgConfigHome, { recursive: true, mode: 0o700 }),
        mkdir(paths.xdgDataHome, { recursive: true, mode: 0o700 }),
      ]);
      if (flags.reuseLocal === true) {
        const projected = await projectLocalSubscriptionCredentials({
          profile,
          paths,
          ambient: process.env,
        });
        if (projected.length === 0) {
          throw new Error(`no allowlisted local subscription credential found for ${profileId}`);
        }
        process.stdout.write(`projected ${projected.length} credential file(s) into ${profileId}\n`);
        return;
      }
      const environment = buildManagedEnvironment({
        profile,
        paths,
        ambient: process.env,
        forwardedKeys: [],
        executablePath: process.env.PATH ?? "/usr/bin:/bin",
      });
      const code = await runInteractive(authCommand({
        profile,
        managedEnvironment: environment,
        piExecutable: join(paths.packages, "node_modules", ".bin", "pi"),
      }), project.root);
      if (code !== 0) throw new Error(`authentication command exited with code ${code}`);
    });
  program
    .command("start [path]")
    .description("Start the isolated Pi orchestrator in this project")
    .action(async (path: string | undefined) => {
      const root = path ?? ".";
      const packageRoot = await findPackageRoot(import.meta.url, "pi-multi-agent-harness");
      const code = await runInteractive({
        executable: "pi",
        argv: [
          "--no-extensions", "--no-skills", "--no-prompt-templates",
          "--no-context-files", "--no-themes", "--approve",
          "--extension", join(packageRoot, "dist/pi/extension.js"),
        ],
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      }, root);
      if (code !== 0) throw new Error(`Pi orchestrator exited with code ${code}`);
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
    .action(async (runId: string, path: string | undefined) => {
      const root = path ?? ".";
      const lock = await readTrustedHarnessLock(root);
      const runPaths = await resolveRunPaths(root, runId);
      const frozen = await readResolvedRunConfig(runPaths.resolvedConfig);
      const managed = await (
        dependencies.createManagedRuntimeFromResolved ?? createManagedPiRuntimeFromResolved
      )({
        profiles: frozen.workflow.profiles,
        runtimeVersion: lock.harnessVersion,
        packageRoot: await findPackageRoot(import.meta.url, "pi-multi-agent-harness"),
      });
      let production: Awaited<ReturnType<typeof createStandaloneProductionEffects>> | undefined;
      try {
        const summary = await recover(
          { root, runId },
          {
            ownerId: `recover:${process.pid}:${crypto.randomUUID()}`,
            lifecycle: createWorkflowLifecycle(),
            effects: {
              recover: async (intent) => {
                production ??= await (dependencies.createStandaloneEffects ?? createStandaloneProductionEffects)({
                  root,
                  runId,
                  workflow: frozen.workflow,
                  commands: frozen.commands,
                  managedPiRuntime: managed,
                });
                return await production.effects.recover(intent) as JsonValue;
              },
            },
          },
        );
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } finally {
        await production?.dispose();
      }
    });
  await program.parseAsync([...argv], { from: "user" });
  return 0;
}
