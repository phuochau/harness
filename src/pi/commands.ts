import { randomUUID } from "node:crypto";
import type { JsonValue } from "../contracts/common.js";
import type { ControllerCommand } from "../contracts/controller-command.js";
import {
  renderGraph,
  renderRunPreview,
  renderStatus,
  renderTask,
} from "./status-view.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { sha256 } from "../shared/sha256.js";

export const harnessCommandNames = [
  "harness-run",
  "harness-status",
  "harness-graph",
  "harness-task",
  "harness-logs",
  "harness-retry",
  "harness-reroute",
  "harness-cancel",
  "harness-pause",
  "harness-resume",
  "harness-doctor",
] as const;

export type HarnessCommandName = (typeof harnessCommandNames)[number];

export interface RunPreview {
  readonly workflowHash: string;
  readonly commands: Readonly<Record<string, readonly string[]>>;
  readonly workers: readonly string[];
  readonly credentialProfiles: readonly string[];
  readonly permissions: readonly string[];
  readonly branches: readonly string[];
  readonly effects: readonly string[];
}

export interface HarnessCommandBackend {
  snapshot(): Promise<unknown>;
  graph(): Promise<unknown>;
  logs(target?: string): Promise<readonly string[]>;
  doctor(): Promise<{ readonly ready: boolean; readonly summary: string }>;
  previewRun(target?: string): Promise<RunPreview>;
  enqueue(command: ControllerCommand): Promise<void>;
}

export interface HarnessCommandUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  confirm(title: string, message?: string): Promise<boolean>;
}

function requiredTarget(args: string, operation: string): string {
  const target = args.trim().split(/\s+/)[0];
  if (!target) throw new Error(`${operation} requires a task or run target`);
  return target;
}

export class HarnessCommandService {
  public constructor(
    private readonly backend: HarnessCommandBackend,
    private readonly nextId: () => string = randomUUID,
  ) {}

  private async intent(payload: JsonValue): Promise<void> {
    await this.backend.enqueue({
      schemaVersion: 1,
      source: "operator",
      kind: "operator_intent",
      idempotencyKey: this.nextId(),
      payload,
    });
  }

  public async execute(
    command: HarnessCommandName,
    args: string,
    ui: HarnessCommandUi,
  ): Promise<void> {
    if (command === "harness-status") {
      ui.notify(renderStatus(await this.backend.snapshot()), "info");
      return;
    }
    if (command === "harness-graph") {
      ui.notify(renderGraph(await this.backend.graph()), "info");
      return;
    }
    if (command === "harness-task") {
      const target = requiredTarget(args, "task");
      ui.notify(renderTask(await this.backend.snapshot(), target), "info");
      return;
    }
    if (command === "harness-logs") {
      ui.notify((await this.backend.logs(args.trim() || undefined)).join("\n"), "info");
      return;
    }
    if (command === "harness-doctor") {
      const result = await this.backend.doctor();
      ui.notify(result.summary, result.ready ? "info" : "warning");
      return;
    }
    if (command === "harness-run") {
      const target = args.trim() || undefined;
      const preview = await this.backend.previewRun(target);
      ui.notify(renderRunPreview(preview), "info");
      if (!(await ui.confirm("Start harness run?", "Approve the displayed effects"))) return;
      await this.intent({
        operation: "run",
        approvedPreviewHash: sha256(canonicalJson(preview)),
        ...(target === undefined ? {} : { target }),
      });
      return;
    }
    if (command === "harness-pause" || command === "harness-resume") {
      await this.intent({
        operation: command.slice("harness-".length),
        target: "run",
        arguments: {},
      });
      return;
    }
    const parts = args.trim().split(/\s+/);
    const target = requiredTarget(args, command);
    if (command === "harness-reroute") {
      const worker = parts[1];
      if (!worker || !["codex", "devin", "claude"].includes(worker)) {
        throw new Error("reroute requires TNNN and one of codex, devin, claude");
      }
      await this.intent({ operation: "reroute", target, arguments: { worker } });
      return;
    }
    await this.intent({
      operation: command.slice("harness-".length),
      target,
      arguments: {},
    });
  }
}
