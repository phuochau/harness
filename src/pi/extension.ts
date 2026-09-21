import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function harnessExtension(pi: ExtensionAPI): void {
  pi.registerCommand("harness-doctor", {
    description: "Report whether the harness extension loaded",
    handler: async (_args, ctx) =>
      ctx.ui.notify("Harness extension loaded", "info"),
  });
}
