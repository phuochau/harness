# Pi Multi-Agent Orchestrator

`pi-multi-agent-harness` turns a Spec Kit feature plan into a dependency-aware,
multi-agent engineering run. Pi owns global orchestration; Codex, Devin, and
Claude are workers; Superpowers is the engineering discipline inside workers;
tests and CI decide correctness.

The default editable workflow is immediately usable and prefers Devin → Codex
→ Claude for implementation, then Codex → Claude → Devin for independent
review. Change those arrays in `.harness/workflow.yaml` or select one of the
generated workflow variants—worker order is data, not hard-coded policy.

## Quick start

Requirements: Node.js 22.19+, Git, Pi 0.86.1, Spec Kit 0.8.7, Superpowers
6.4.1, Herdr 0.9.1, and whichever worker CLIs the selected workflow uses.

```bash
cd your-project
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness init
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness bootstrap --dry-run .
```

Inspect the content-addressed plan. After resolving any manual blockers, run:

```bash
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness bootstrap --yes .
harness doctor --json .
harness start .
```

Inside the dedicated Pi session, use `/harness-run`, review its effects, and
approve the run. Operational commands include `harness status`, `graph`,
`explain`, and `recover`; Pi also registers `/harness-status`,
`/harness-graph`, `/harness-retry`, `/harness-reroute`, `/harness-pause`, and
the related run commands.

## Runtime shape

```text
Human + Spec Kit → spec / plan / tasks / task graph
                 → Pi controller
                 → Herdr workspaces and isolated worktrees
                 → Codex / Devin / Claude + Superpowers
                 → task tests → independent review → integration
                 → final verification → final review → push → one PR
```

Every task gets a separate branch, worktree, agent identity, assignment hash,
and structured result. An agent result is not `DONE`; the controller requires
evidence, verification, integration, and task-status projection first. Run
state is a fenced, hash-chained journal under the repository's Git common
directory, so linked worktrees share one durable run identity.

## Documentation

- [Installation and bootstrap](docs/installation.md)
- [Workflow DSL](docs/workflow-dsl.md)
- [Recovery and operations](docs/recovery.md)
- [Security model](SECURITY.md)
- [Release process](docs/releasing.md)

This release intentionally excludes remote access/Tailscale setup. That is a
separate deployment concern and does not belong in the orchestration trust
boundary.
