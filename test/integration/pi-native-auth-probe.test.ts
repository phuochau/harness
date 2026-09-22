import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkPiNativeAuth } from "../../src/providers/pi-native-auth-probe.js";
import { NodeProcessRunner } from "../../src/git/process.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

it("checks authentication after a declared native Pi extension registers its provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-native-auth-"));
  temporary.push(root);
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const extension = join(root, "provider.mjs");
  await writeFile(extension, `export default function (pi) {
    pi.registerProvider("fixture-native", {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "local",
      api: "openai-completions",
      models: [{ id: "fixture-model", name: "Fixture", reasoning: false,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192, maxTokens: 1024 }],
    });
  };
`);
  const input = { piCliPath: join(process.cwd(), "node_modules/.bin/pi"),
    provider: "fixture-native", model: "fixture-native/fixture-model",
    extensionPaths: [extension], agentDir, cwd: root };
  expect(await checkPiNativeAuth(input)).toEqual({ status: "ready" });
  expect(await checkPiNativeAuth({ ...input, extensionPaths: [] }))
    .toEqual({ status: "not_ready", reason: "provider_or_model_not_found" });
  const command = await new NodeProcessRunner().run(process.execPath,
    [join(process.cwd(), "dist/providers/pi-native-auth-probe.js"), input.piCliPath,
      input.provider, input.model, extension],
    { shell: false, cwd: root, env: { HOME: root, PI_CODING_AGENT_DIR: agentDir,
      PATH: process.env.PATH ?? "/usr/bin:/bin", XDG_CONFIG_HOME: root, XDG_DATA_HOME: root } });
  expect(command.exitCode).toBe(0);
  expect(JSON.parse(command.stdout)).toEqual({ status: "ready" });
});
