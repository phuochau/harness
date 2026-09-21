import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function workerTransportExtension(pi: ExtensionAPI): void {
  pi.on("agent_settled", async () => {
    process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  });
}
