import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedProfile } from "../../../src/config/profiles.js";
import type { PiProcessSupervisor } from "../../../src/runtime/pi-process/types.js";
import type { ManagedProfileView } from "../../../src/runtime/managed/materialize.js";
import { PiWorkerRuntime } from "../../../src/runtime/pi-worker/runtime.js";
import { sha256 } from "../../../src/shared/sha256.js";
import { FakeProcessRunner } from "../../support/fake-process.js";
import { fixtureResolvedProfiles } from "../../support/factories.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function managedView(overrides: Partial<ManagedProfileView> = {}): ManagedProfileView {
  return {
    extensionPaths: [],
    piSkillPaths: [],
    providerSkillPaths: [],
    promptTemplatePaths: [],
    environment: {
      HOME: "/managed/home",
      PI_CODING_AGENT_DIR: "/managed/pi-agent",
      PATH: "/usr/bin:/bin",
    },
    receiptHash: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function runtime(
  process: FakeProcessRunner,
  managedProfiles: Readonly<Record<string, ManagedProfileView>>,
): PiWorkerRuntime {
  return new PiWorkerRuntime({
    profiles: fixtureResolvedProfiles(),
    managedProfiles,
    supervisor: undefined as unknown as PiProcessSupervisor,
    piExecutable: "/managed/bin/node",
    piExecutableArgs: ["/managed/pi/cli.js"],
    transportExtensionPath: "/managed/transport.js",
    process,
  });
}

function queueProbeSequence(
  process: FakeProcessRunner,
  modelsStdout: string,
  authStdout = '{"status":"ready"}',
): void {
  process.queue({ exitCode: 0, stdout: "0.86.1", stderr: "" });
  process.queue({ exitCode: 0, stdout: modelsStdout, stderr: "" });
  process.queue({ exitCode: 0, stdout: authStdout, stderr: "" });
}

function piTable(rows: readonly (readonly [string, string])[]): string {
  const header = "provider  model            context  max-out  thinking  images";
  const body = rows.map(
    ([provider, model]) =>
      `${provider.padEnd(8)}  ${model.padEnd(15)}  128K     16.4K    no        no`,
  );
  return `${[header, ...body].join("\n")}\n`;
}

const zaiProfile: ResolvedProfile = {
  id: "zai-glm",
  family: "glm",
  runtime: "pi",
  provider: "zai",
  model: "zai/glm-5.3",
  role: "implementation",
  environment: "isolated",
  tools: [],
  extensions: [],
  skills: [],
  promptTemplates: [],
  contextFiles: false,
  mcp: [],
  hash: sha256("zai-glm"),
};

const qwenProfile: ResolvedProfile = {
  id: "local-qwen",
  family: "qwen",
  runtime: "pi",
  provider: "ollama",
  model: "qwen3-coder:30b",
  modelConfig: {
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    name: "Qwen3-Coder 30B",
  },
  role: "implementation",
  environment: "isolated",
  tools: [],
  extensions: [],
  skills: [],
  promptTemplates: [],
  contextFiles: false,
  mcp: [],
  hash: sha256("local-qwen"),
};

describe("Pi worker model preflight", () => {
  it("does not let a similarly prefixed model satisfy an exact request", async () => {
    const process = new FakeProcessRunner();
    queueProbeSequence(process, piTable([["zai", "glm-5.3-flash"]]));
    const probe = await runtime(process, { "zai-glm": managedView() }).probe(zaiProfile);
    expect(probe.providerRegistered).toBe(true);
    expect(probe.modelAvailable).toBe(false);
    expect(probe.available).toBe(false);
    expect(probe.evidence.join(" ")).toContain("model missing");
  });

  it("accepts an exact provider and model row", async () => {
    const process = new FakeProcessRunner();
    queueProbeSequence(
      process,
      piTable([
        ["zai", "glm-5.3-flash"],
        ["zai", "glm-5.3"],
      ]),
    );
    const probe = await runtime(process, { "zai-glm": managedView() }).probe(zaiProfile);
    expect(probe.modelAvailable).toBe(true);
    expect(probe.available).toBe(true);
  });

  it("distinguishes a missing model from missing authentication", async () => {
    const process = new FakeProcessRunner();
    queueProbeSequence(
      process,
      piTable([["zai", "glm-5.3"]]),
      '{"status":"not_ready","reason":"credentials_not_configured"}',
    );
    const probe = await runtime(process, { "zai-glm": managedView() }).probe(zaiProfile);
    expect(probe.modelAvailable).toBe(true);
    expect(probe.authenticated).toBe(false);
    expect(probe.available).toBe(false);
  });

  it("requires a materialized catalog for custom model profiles", async () => {
    const process = new FakeProcessRunner();
    queueProbeSequence(process, piTable([["ollama", "qwen3-coder:30b"]]));
    const missing = await runtime(process, { "local-qwen": managedView() }).probe(qwenProfile);
    expect(missing.available).toBe(false);
    expect(missing.resourcesVerified).toBe(false);

    const root = await mkdtemp(join(tmpdir(), "pi-model-probe-"));
    temporary.push(root);
    const catalogPath = join(root, "models.json");
    const catalogContent = `${JSON.stringify({ providers: {} }, null, 2)}\n`;
    await writeFile(catalogPath, catalogContent, { mode: 0o600 });
    const readyProcess = new FakeProcessRunner();
    queueProbeSequence(readyProcess, piTable([["ollama", "qwen3-coder:30b"]]));
    const ready = await runtime(readyProcess, {
      "local-qwen": managedView({
        modelCatalogPath: catalogPath,
        modelCatalogHash: sha256(catalogContent),
      }),
    }).probe(qwenProfile);
    expect(ready.resourcesVerified).toBe(true);
    expect(ready.available).toBe(true);

    await writeFile(catalogPath, "tampered\n");
    const tamperedProcess = new FakeProcessRunner();
    queueProbeSequence(tamperedProcess, piTable([["ollama", "qwen3-coder:30b"]]));
    const tampered = await runtime(tamperedProcess, {
      "local-qwen": managedView({
        modelCatalogPath: catalogPath,
        modelCatalogHash: sha256(catalogContent),
      }),
    }).probe(qwenProfile);
    expect(tampered.available).toBe(false);
    expect(tampered.resourcesVerified).toBe(false);
    expect(tampered.evidence.join(" ")).toContain("content hash mismatch");
  });

  it("keeps Codex and Devin bridge probes unchanged", async () => {
    const cases: readonly [string, string, string, string][] = [
      ["implementer-devin", "devin", "swe-2", "logged in"],
      ["planner-codex", "openai-codex", "gpt-5.6-luna", '{"loggedIn":true}'],
    ];
    for (const [id, provider, modelId, authStdout] of cases) {
      const process = new FakeProcessRunner();
      queueProbeSequence(process, piTable([[provider, modelId]]), authStdout);
      const profile = fixtureResolvedProfiles().byId[id]!;
      const probe = await runtime(process, { [id]: managedView() }).probe(profile);
      expect(probe.modelAvailable).toBe(true);
      expect(probe.available).toBe(true);
    }
  });
});
