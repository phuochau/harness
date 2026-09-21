import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createLazyExtensionDependencies,
  type LazyExtensionDependencies,
} from "./dependencies.js";

export function registerHarnessCommands(
  pi: ExtensionAPI,
  dependencies: LazyExtensionDependencies,
): void {
  pi.registerCommand("harness-doctor", {
    description: "Report whether the harness extension loaded",
    handler: async (_args, ctx) => {
      const session = dependencies.current();
      ctx.ui.notify(
        session === undefined
          ? "Harness extension loaded; session dependencies are idle"
          : `Harness extension active in ${session.cwd}`,
        "info",
      );
    },
  });
}

export function registerHarnessEvents(
  pi: ExtensionAPI,
  dependencies: LazyExtensionDependencies,
): void {
  pi.on("session_start", async (_event, context) => {
    await dependencies.start(context);
  });
  pi.on("session_shutdown", async () => {
    await dependencies.dispose();
  });
}

export default function harnessExtension(
  pi: ExtensionAPI,
  dependencies: LazyExtensionDependencies = createLazyExtensionDependencies(),
): void {
  registerHarnessCommands(pi, dependencies);
  registerHarnessEvents(pi, dependencies);
}
