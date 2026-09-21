import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiExtensionDependencies,
  type LazyExtensionDependencies,
} from "./dependencies.js";
import {
  harnessCommandNames,
  type HarnessCommandName,
} from "./commands.js";
import { PiPlanningEventStateMachine } from "./events.js";

export function registerHarnessCommands(
  pi: ExtensionAPI,
  dependencies: LazyExtensionDependencies,
): void {
  for (const command of harnessCommandNames) {
    pi.registerCommand(command, {
      description: `Pi harness: ${command.slice("harness-".length)}`,
      handler: async (args, ctx) => {
        const service = dependencies.current()?.commands;
        if (service !== undefined) {
          await service.execute(command as HarnessCommandName, args, ctx.ui);
          return;
        }
        if (command !== "harness-doctor") {
          ctx.ui.notify("Harness session is not initialized for this project", "error");
          return;
        }
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
}

export function registerHarnessEvents(
  pi: ExtensionAPI,
  dependencies: LazyExtensionDependencies,
): void {
  let planningEvents: PiPlanningEventStateMachine | undefined;
  pi.on("session_start", async (_event, context) => {
    planningEvents = new PiPlanningEventStateMachine({
      appendEntry: (type, data) => {
        pi.appendEntry(type, data);
        const entryId = context.sessionManager.getLeafId();
        if (!entryId) throw new Error(`Pi did not persist ${type}`);
        return entryId;
      },
      hasEntry: async (type, correlationId) =>
        context.sessionManager.getBranch().some((entry) => {
          if (entry.type !== "custom" || entry.customType !== type) return false;
          const data = entry.data;
          return (
            typeof data === "object" &&
            data !== null &&
            (data as { correlationId?: unknown }).correlationId === correlationId
          );
        }),
    });
    const session = await dependencies.start(context);
    await session.events?.pi("session_start", { cwd: context.cwd });
  });
  pi.on("session_shutdown", async (event) => {
    await dependencies.current()?.events?.pi("session_shutdown", {
      reason: event.reason,
    });
    await dependencies.dispose();
    planningEvents = undefined;
  });
  pi.on("before_agent_start", async (event) => {
    await planningEvents?.beforeAgentStart(event.prompt);
    await dependencies.current()?.events?.pi("before_agent_start", {
      correlatedPlanning: event.prompt.includes("<!-- harness-planning:"),
    });
  });
  pi.on("turn_start", async (event) => {
    await planningEvents?.turnStart(event.turnIndex);
    await dependencies.current()?.events?.pi("turn_start", {
      turnIndex: event.turnIndex,
      timestamp: event.timestamp,
    });
  });
  pi.on("turn_end", async (event) => {
    planningEvents?.turnEnd(event.turnIndex);
    await dependencies.current()?.events?.pi("turn_end", {
      turnIndex: event.turnIndex,
      toolResultCount: event.toolResults.length,
    });
  });
  pi.on("agent_settled", async () => {
    await planningEvents?.agentSettled();
    await dependencies.current()?.events?.pi("agent_settled", {});
  });
  pi.on("model_select", async (event) => {
    await dependencies.current()?.events?.pi("model_select", {
      provider: event.model.provider,
      modelId: event.model.id,
      source: event.source,
    });
  });
  pi.on("thinking_level_select", async (event) => {
    await dependencies.current()?.events?.pi("thinking_level_select", {
      level: event.level,
    });
  });
}

export default function harnessExtension(
  pi: ExtensionAPI,
  dependencies?: LazyExtensionDependencies,
): void {
  const resolved = dependencies ?? createPiExtensionDependencies(pi);
  registerHarnessCommands(pi, resolved);
  registerHarnessEvents(pi, resolved);
}
