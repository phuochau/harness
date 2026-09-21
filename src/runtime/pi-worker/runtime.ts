import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "../../actions/types.js";
import type { ResolvedProfile, ResolvedProfiles } from "../../config/profiles.js";
import type { WorkerAssignment } from "../../core/assignment.js";
import type { WorkerResult } from "../../contracts/worker-result.js";
import { sha256 } from "../../shared/sha256.js";
import type { ManagedProfileView } from "../managed/materialize.js";
import type {
  CancellationEvidence,
  PiProcessObservation,
  PiProcessRecord,
  PiProcessSupervisor,
} from "../pi-process/types.js";
import { buildWorkerPrompt } from "../workers/prompt.js";
import { superpowersProfile } from "../workers/superpowers-profile.js";
import type { ParsedWorkerResult } from "../workers/types.js";
import { buildPiLaunchSpec, buildPiProbePrefix } from "./launch-spec.js";
import { collectPiWorkerResult } from "./results.js";
import type { PiLaunchSpec } from "../pi-process/types.js";

export interface ProfileCapabilities {
  readonly available: boolean;
  readonly providerRegistered: boolean;
  readonly modelAvailable: boolean;
  readonly authenticated: boolean;
  readonly resourcesVerified: boolean;
  readonly evidence: readonly string[];
}

export interface PreparedPiAttempt {
  readonly attemptId: string;
  readonly assignment: WorkerAssignment;
  readonly profile: ResolvedProfile;
  readonly launch: PiLaunchSpec;
  readonly prompt: string;
  readonly resultPath: string;
}

export interface PiWorkerHandle {
  readonly attemptId: string;
  readonly process: PiProcessRecord;
}

export type PiWorkerObservation = PiProcessObservation;

export interface AttemptRecord {
  readonly attemptId: string;
  readonly process?: PiProcessRecord;
  readonly providerSession?: { readonly source: string; readonly id: string };
}

export type RecoveryDecision =
  | { readonly status: "running"; readonly handle: PiWorkerHandle }
  | { readonly status: "observed"; readonly result: WorkerResult }
  | { readonly status: "resume"; readonly sessionId: string }
  | { readonly status: "retry"; readonly reason: string }
  | { readonly status: "indeterminate"; readonly evidence: readonly string[] };

export interface PiWorkerRuntimeOptions {
  readonly profiles: ResolvedProfiles;
  readonly managedProfiles: Readonly<Record<string, ManagedProfileView>>;
  readonly supervisor: PiProcessSupervisor;
  readonly piExecutable: string;
  readonly piExecutableArgs?: readonly string[];
  readonly transportExtensionPath: string;
  readonly process?: ProcessRunner;
}

function attemptId(assignment: WorkerAssignment): string {
  return `${assignment.runId}:${assignment.jobId}:${assignment.attempt}`;
}

async function verifyManagedResources(
  profile: ResolvedProfile,
  managed: ManagedProfileView,
): Promise<{ verified: boolean; evidence: readonly string[] }> {
  const evidence: string[] = [];
  let verified = /^sha256:[0-9a-f]{64}$/.test(managed.receiptHash);
  const paths = [
    ...managed.extensionPaths,
    ...managed.piSkillPaths,
    ...managed.providerSkillPaths,
    ...managed.promptTemplatePaths,
  ];
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        verified = false;
        evidence.push("managed resource is not a real file or directory");
      }
    } catch {
      verified = false;
      evidence.push("managed resource is missing");
    }
  }
  if (profile.family === "devin") {
    const home = managed.environment.HOME;
    if (
      home === undefined ||
      managed.providerSkillPaths.some((path) => !path.startsWith(`${home}/.agents/skills/`))
    ) {
      verified = false;
      evidence.push("Devin provider skills escape the managed home");
    }
  }
  if (profile.family === "claude") {
    const agentDirectory = managed.environment.PI_CODING_AGENT_DIR;
    try {
      if (agentDirectory === undefined) throw new Error("missing Pi agent directory");
      const configuration = JSON.parse(
        await readFile(join(agentDirectory, "claude-bridge.json"), "utf8"),
      ) as Record<string, unknown>;
      const askClaude = configuration.askClaude as Record<string, unknown> | undefined;
      if (
        configuration.strictMcpConfig !== true ||
        configuration.autoMemoryEnabled !== false ||
        askClaude?.enabled !== false
      ) {
        throw new Error("unsafe Claude bridge settings");
      }
    } catch {
      verified = false;
      evidence.push("Claude bridge strict configuration is missing or unsafe");
    }
  }
  if (verified) evidence.push("managed profile resources verified");
  return { verified, evidence };
}

export function recoverInterruptedDevin(input: {
  readonly piSessionId: string;
  readonly priorProviderSessionId: string;
  readonly loadedProviderSessionId: string;
}): RecoveryDecision {
  if (input.priorProviderSessionId !== input.loadedProviderSessionId) {
    return { status: "retry", reason: "provider session identity changed" };
  }
  return { status: "resume", sessionId: input.piSessionId };
}

export class PiWorkerRuntime {
  private readonly handles = new Map<string, PiWorkerHandle>();

  public constructor(private readonly options: PiWorkerRuntimeOptions) {}

  private resources(profile: ResolvedProfile): ManagedProfileView {
    const managed = this.options.managedProfiles[profile.id];
    if (managed === undefined) throw new Error(`managed profile is missing: ${profile.id}`);
    return managed;
  }

  public async probe(profile: ResolvedProfile): Promise<ProfileCapabilities> {
    const managed = this.resources(profile);
    const resourceCheck = await verifyManagedResources(profile, managed);
    if (this.options.process === undefined) {
      return {
        available: false,
        providerRegistered: false,
        modelAvailable: false,
        authenticated: false,
        resourcesVerified: resourceCheck.verified,
        evidence: ["Pi capability process probe is unavailable", ...resourceCheck.evidence],
      };
    }
    const executablePrefix = this.options.piExecutableArgs ?? [];
    const version = await this.options.process.run(this.options.piExecutable, [...executablePrefix, "--version"], {
      env: managed.environment,
      shell: false,
    });
    const prefix = buildPiProbePrefix(profile, managed);
    const models = await this.options.process.run(
      this.options.piExecutable,
      [...executablePrefix, ...prefix, "--list-models", profile.model],
      { env: managed.environment, shell: false },
    );
    const auth = profile.family === "codex" && profile.provider === "pi-shell-acp"
      ? await this.options.process.run("codex", ["login", "status"], { env: managed.environment, shell: false })
      : profile.family === "devin"
        ? await this.options.process.run("devin", ["auth", "status"], { env: managed.environment, shell: false })
        : profile.family === "claude"
          ? await this.options.process.run("claude", ["auth", "status"], { env: managed.environment, shell: false })
          : await this.options.process.run(
              this.options.piExecutable,
              [...executablePrefix, ...prefix, "auth", "check", "--provider", profile.provider, "--json", "--no-refresh"],
              { env: managed.environment, shell: false },
            );
    const providerRegistered = models.exitCode === 0 && !/provider.+not found/i.test(models.stderr);
    const modelAvailable = providerRegistered && models.stdout.includes(profile.model.split("/").at(-1)!);
    let authenticated = false;
    try {
      authenticated = auth.exitCode === 0 && (
        /logged in/i.test(`${auth.stdout}\n${auth.stderr}`) ||
        JSON.parse(auth.stdout).status === "ready" ||
        JSON.parse(auth.stdout).loggedIn === true
      );
    } catch {
      authenticated = false;
    }
    return {
      available: version.exitCode === 0 && providerRegistered && modelAvailable && authenticated && resourceCheck.verified,
      providerRegistered,
      modelAvailable,
      authenticated,
      resourcesVerified: resourceCheck.verified,
      evidence: [
        `Pi executable ${version.exitCode === 0 ? "available" : "unavailable"}`,
        `provider ${providerRegistered ? "registered" : "missing"}`,
        `model ${modelAvailable ? "available" : "missing"}`,
        `authentication ${authenticated ? "ready" : "not ready"}`,
        ...resourceCheck.evidence,
      ],
    };
  }

  public async prepare(assignment: WorkerAssignment): Promise<PreparedPiAttempt> {
    const profile = this.options.profiles.byId[assignment.profileId];
    if (profile === undefined) throw new Error(`resolved profile is missing: ${assignment.profileId}`);
    if (profile.family !== assignment.profileFamily || profile.role !== assignment.role) {
      throw new Error("assignment does not match its resolved Pi profile");
    }
    if (
      assignment.role === "review" &&
      assignment.implementationProfileFamily === profile.family
    ) {
      throw new Error("task review requires a different profile family");
    }
    const prompt = buildWorkerPrompt(assignment, superpowersProfile(assignment));
    const output = join(assignment.worktree.path, ".harness-output");
    await mkdir(output, { recursive: true, mode: 0o700 });
    const outputInfo = await lstat(output);
    if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
      throw new Error("worker output path is not a real directory");
    }
    const resultPath = join(output, "result.json");
    await rm(resultPath, { force: true });
    const assignmentPath = join(output, "assignment.md");
    await unlink(assignmentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    for (const entry of await readdir(output)) {
      if (/^pi-evidence-[1-9][0-9]*\.txt$/.test(entry)) await unlink(join(output, entry));
    }
    await writeFile(assignmentPath, prompt, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const id = attemptId(assignment);
    const sessionId = randomUUID();
    const sessionDir = join(output, "sessions", sha256(id).slice(7, 31));
    const launch = buildPiLaunchSpec({
      attemptId: id,
      attemptToken: randomUUID(),
      piExecutable: this.options.piExecutable,
      ...(this.options.piExecutableArgs === undefined ? {} : { piExecutableArgs: this.options.piExecutableArgs }),
      profile,
      managed: this.resources(profile),
      transportExtensionPath: this.options.transportExtensionPath,
      cwd: assignment.worktree.path,
      sessionId,
      sessionDir,
      prompt: "Read .harness-output/assignment.md and execute that harness assignment exactly.",
    });
    return { attemptId: id, assignment, profile, launch, prompt, resultPath };
  }

  public async launch(prepared: PreparedPiAttempt): Promise<PiWorkerHandle> {
    const process = await this.options.supervisor.launch(prepared.launch);
    const handle = { attemptId: prepared.attemptId, process };
    this.handles.set(prepared.attemptId, handle);
    return handle;
  }

  public observe(handle: PiWorkerHandle): Promise<PiWorkerObservation> {
    return this.options.supervisor.observe(handle.process);
  }

  public async recover(
    prepared: PreparedPiAttempt,
    record: AttemptRecord,
  ): Promise<RecoveryDecision> {
    if (record.attemptId !== prepared.attemptId) {
      return { status: "indeterminate", evidence: ["attempt identity mismatch"] };
    }
    if (record.process !== undefined) {
      const observation = await this.options.supervisor.observe(record.process);
      if (observation.status === "running") {
        const handle = { attemptId: prepared.attemptId, process: record.process };
        this.handles.set(prepared.attemptId, handle);
        return { status: "running", handle };
      }
      if (observation.status === "identity_mismatch") {
        return { status: "indeterminate", evidence: observation.evidence };
      }
      if (observation.status === "exited") {
        if (observation.exit.exitCode !== null && observation.exit.exitCode !== 0) {
          return {
            status: "retry",
            reason: `Pi process exited with code ${observation.exit.exitCode}`,
          };
        }
        if (observation.exit.signal !== null) {
          return {
            status: "retry",
            reason: `Pi process exited from signal ${observation.exit.signal}`,
          };
        }
        this.handles.set(prepared.attemptId, {
          attemptId: prepared.attemptId,
          process: record.process,
        });
        const parsed = await collectPiWorkerResult({
          assignment: prepared.assignment,
          resultPath: prepared.resultPath,
          terminal: observation.exit.terminal,
        });
        if (parsed.status === "valid") return { status: "observed", result: parsed.result };
        return { status: "retry", reason: parsed.reason };
      }
    }
    if (record.providerSession !== undefined && prepared.profile.family !== "devin") {
      return { status: "resume", sessionId: record.providerSession.id };
    }
    return {
      status: "retry",
      reason: prepared.profile.family === "devin"
        ? "Devin provider session cannot be proven resumable"
        : "Pi process is no longer observable",
    };
  }

  public cancel(handle: PiWorkerHandle): Promise<CancellationEvidence> {
    return this.options.supervisor.cancel(handle.process, 30_000);
  }

  public async collect(prepared: PreparedPiAttempt): Promise<ParsedWorkerResult> {
    const handle = this.handles.get(prepared.attemptId);
    if (handle === undefined) return { status: "invalid", reason: "Pi worker was not launched" };
    const exit = await this.options.supervisor.wait(handle.process);
    if (exit.exitCode !== null && exit.exitCode !== 0) {
      return { status: "invalid", reason: `Pi process exited with code ${exit.exitCode}` };
    }
    if (exit.signal !== null) {
      return { status: "invalid", reason: `Pi process exited from signal ${exit.signal}` };
    }
    return collectPiWorkerResult({
      assignment: prepared.assignment,
      resultPath: prepared.resultPath,
      terminal: exit.terminal,
    });
  }
}
