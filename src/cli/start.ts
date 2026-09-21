import { sha256 } from "../shared/sha256.js";
import { realpath } from "node:fs/promises";
import type { ProcessRunner } from "../actions/types.js";
import type { HerdrAgent, HerdrClient } from "../runtime/herdr/client.js";

export interface ControllerAgent {
  readonly name: string;
  readonly kind: "pi";
  readonly workspaceId: string;
  readonly paneId: string;
  readonly status: string;
}

export interface StartDependencies {
  readonly git: {
    inspect(root: string): Promise<{ readonly root: string; readonly identity: string }>;
  };
  readonly herdr: {
    ensureWorkspace(input: {
      readonly label: string;
      readonly cwd: string;
    }): Promise<{ readonly id: string; readonly rootPaneId: string }>;
    findAgent(input: {
      readonly name: string;
      readonly workspaceId: string;
      readonly paneId: string;
    }): Promise<ControllerAgent | undefined>;
    startAgent(input: {
      readonly name: string;
      readonly kind: "pi";
      readonly paneId: string;
      readonly cwd: string;
    }): Promise<ControllerAgent>;
    waitFor(name: string, status: "idle"): Promise<void>;
  };
  readonly extensionProbe: { assertReady(name: string): Promise<void> };
}

export interface StartOptions {
  readonly root: string;
}

export interface StartResult {
  readonly mode: "started" | "reattached";
  readonly agent: ControllerAgent;
}

export function stableControllerAgentName(repositoryIdentity: string): string {
  return `h-controller-${sha256(repositoryIdentity).slice("sha256:".length, "sha256:".length + 16)}`;
}

function agentHandle(agent: HerdrAgent): ControllerAgent {
  if (
    typeof agent.name !== "string" ||
    agent.agent !== "pi"
  ) {
    throw new Error("Herdr agent is not the named Pi controller");
  }
  return {
    name: agent.name,
    kind: "pi",
    workspaceId: agent.workspace_id,
    paneId: agent.pane_id,
    status: agent.agent_status,
  };
}

export function installedStartDependencies(
  processRunner: ProcessRunner,
  client: HerdrClient,
): StartDependencies {
  return {
    git: {
      async inspect(rootInput) {
        const cwd = await realpath(rootInput);
        const [top, common] = await Promise.all([
          processRunner.run("git", ["rev-parse", "--show-toplevel"], { cwd, shell: false }),
          processRunner.run("git", ["rev-parse", "--git-common-dir"], { cwd, shell: false }),
        ]);
        if (top.exitCode !== 0 || common.exitCode !== 0) {
          throw new Error("start requires a Git repository");
        }
        const root = await realpath(top.stdout.trim());
        const identity = sha256(`${root}\0${common.stdout.trim()}`);
        return { root, identity };
      },
    },
    herdr: {
      async ensureWorkspace(input) {
        const listed = await client.request("workspace.list", {});
        const matches = listed.workspaces.filter((workspace) => workspace.label === input.label);
        if (matches.length > 1) throw new Error("duplicate Herdr controller workspaces");
        if (matches.length === 1) {
          const workspace = matches[0]!;
          const raw = await client.request("pane.list", { workspace_id: workspace.workspace_id });
          const panes = (raw as { panes?: readonly { pane_id?: unknown }[] }).panes ?? [];
          const pane = panes.find((item) => typeof item.pane_id === "string");
          if (pane === undefined) throw new Error("Herdr controller workspace has no pane");
          return { id: workspace.workspace_id, rootPaneId: pane.pane_id as string };
        }
        const created = await client.request("workspace.create", {
          cwd: input.cwd,
          label: input.label,
          focus: false,
        });
        return {
          id: created.workspace.workspace_id,
          rootPaneId: created.root_pane.pane_id,
        };
      },
      async findAgent(input) {
        const response = await client.request("agent.list", {});
        const matches = response.agents.filter(
          (agent) =>
            agent.name === input.name &&
            agent.workspace_id === input.workspaceId &&
            agent.pane_id === input.paneId,
        );
        if (matches.length > 1) throw new Error("duplicate Herdr Pi controller agents");
        return matches[0] === undefined ? undefined : agentHandle(matches[0]);
      },
      async startAgent(input) {
        const response = await client.request("agent.start", {
          name: input.name,
          kind: input.kind,
          pane_id: input.paneId,
          args: [],
          timeout_ms: 30_000,
        });
        return agentHandle(response.agent);
      },
      async waitFor(name, status) {
        await client.request("agent.wait", {
          target: name,
          until: [status],
          timeout_ms: 30_000,
        });
      },
    },
    extensionProbe: {
      async assertReady(name) {
        const response = await client.request("agent.get", { target: name });
        if (response.agent.agent_status === "unknown") {
          throw new Error("Pi controller did not reach a known state");
        }
      },
    },
  };
}

export async function start(
  options: StartOptions,
  dependencies: StartDependencies,
): Promise<StartResult> {
  const repository = await dependencies.git.inspect(options.root);
  const workspace = await dependencies.herdr.ensureWorkspace({
    label: `harness:${repository.identity}`,
    cwd: repository.root,
  });
  const name = stableControllerAgentName(repository.identity);
  const existing = await dependencies.herdr.findAgent({
    name,
    workspaceId: workspace.id,
    paneId: workspace.rootPaneId,
  });
  const agent = existing ?? await dependencies.herdr.startAgent({
    name,
    kind: "pi",
    paneId: workspace.rootPaneId,
    cwd: repository.root,
  });
  if (
    agent.name !== name ||
    agent.kind !== "pi" ||
    agent.workspaceId !== workspace.id ||
    agent.paneId !== workspace.rootPaneId
  ) {
    throw new Error("Herdr returned a controller with the wrong stable identity");
  }
  await dependencies.herdr.waitFor(name, "idle");
  await dependencies.extensionProbe.assertReady(name);
  return { mode: existing === undefined ? "started" : "reattached", agent };
}
