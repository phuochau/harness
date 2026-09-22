import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface PiSdk {
  createAgentSessionServices(options: {
    cwd: string;
    agentDir: string;
    resourceLoaderOptions: {
      noExtensions: true;
      noSkills: true;
      noPromptTemplates: true;
      noThemes: true;
      noContextFiles: true;
      additionalExtensionPaths: string[];
    };
  }): Promise<{
    diagnostics: readonly { type: string; message: string }[];
    resourceLoader: { getExtensions(): { errors: readonly unknown[] } };
    modelRuntime: {
      getProvider(id: string): unknown;
      getModel(provider: string, model: string): unknown;
      checkAuth(id: string): Promise<unknown>;
    };
  }>;
}

export async function checkPiNativeAuth(input: {
  piCliPath: string;
  provider: string;
  model: string;
  extensionPaths: readonly string[];
  agentDir: string;
  cwd: string;
}): Promise<{ status: "ready" | "not_ready" | "invalid"; reason?: string }> {
  const cli = await realpath(input.piCliPath);
  const packageRoot = dirname(dirname(dirname(cli)));
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name?: string };
  if (manifest.name !== "@earendil-works/pi-coding-agent") {
    return { status: "invalid", reason: "managed_pi_package_missing" };
  }
  const sdk = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href) as PiSdk;
  const services = await sdk.createAgentSessionServices({
    cwd: input.cwd,
    agentDir: input.agentDir,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [...input.extensionPaths],
    },
  });
  if (services.diagnostics.some((entry) => entry.type === "error") ||
      services.resourceLoader.getExtensions().errors.length > 0) {
    return { status: "invalid", reason: "extension_load_failed" };
  }
  const modelId = input.model.startsWith(`${input.provider}/`)
    ? input.model.slice(input.provider.length + 1)
    : input.model;
  if (!services.modelRuntime.getProvider(input.provider) ||
      !services.modelRuntime.getModel(input.provider, modelId)) {
    return { status: "not_ready", reason: "provider_or_model_not_found" };
  }
  const auth = await services.modelRuntime.checkAuth(input.provider);
  return auth ? { status: "ready" } : { status: "not_ready", reason: "credentials_not_configured" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [piCliPath, provider, model, ...extensionPaths] = process.argv.slice(2);
  if (!piCliPath || !provider || !model || !process.env.PI_CODING_AGENT_DIR) {
    process.stdout.write(JSON.stringify({ status: "invalid", reason: "probe_arguments_missing" }));
    process.exitCode = 2;
  } else {
    try {
      const result = await checkPiNativeAuth({ piCliPath, provider, model, extensionPaths,
        agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() });
      process.stdout.write(JSON.stringify(result));
      process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
    } catch {
      process.stdout.write(JSON.stringify({ status: "invalid", reason: "probe_failed" }));
      process.exitCode = 2;
    }
  }
}
