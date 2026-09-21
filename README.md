# Pi Multi-Agent Orchestrator

`pi-multi-agent-harness` turns Spec Kit artifacts into a durable,
dependency-aware engineering run. Pi is the only orchestrator. The shipped
workflow uses locally authenticated Codex CLI and Devin CLI workers, injects
selected Superpowers skills, isolates tasks in Git worktrees, and accepts
completion only after structured evidence and verification pass.

Worker selection is data in `.harness/workflow.yaml`, not a hard-coded call
chain. The ready-to-use default plans with Codex, prefers Devin then Codex for
implementation, and requires review by a different provider family. The
included `spec-kit-codex.yaml` preset makes Codex the primary implementer.

## Quick start

Requirements: Node.js `>=22.22.2`, Git, Codex CLI and Devin CLI. Codex and Devin
must already be authenticated with the local subscription accounts you intend
to use.

```bash
cd your-project
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness init .
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness setup --dry-run .
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness setup --yes .
harness doctor --json .
harness start .
```

If doctor reports missing authentication, run `harness auth planner-codex .` or
`harness auth implementer-devin .`. To explicitly reuse an existing local CLI
login, add `--reuse-local`; simply opening the extension never copies a
credential. Setup does not remove or edit global Pi packages, skills, plugins,
or MCP configuration.

Inside Pi, `/harness-run <feature-or-run-id>` previews effects and requests run
approval. Operational commands include `harness status`, `graph`, `explain`,
and `recover`, plus the corresponding `/harness-*` Pi commands.

## Runtime shape

```text
Human + Spec Kit -> spec / plan / tasks / task graph
                 -> durable Pi controller
                 -> one worktree + branch + Pi child per READY task
                 -> Codex CLI or Devin CLI + selected Superpowers skills
                 -> tests -> independent review -> integration
                 -> final verification -> push -> pull request
```

Workers never decide `DONE`. Pi validates the assignment identity, allowed
paths, candidate commit, evidence, terminal event, tests, and review result.
Run state is a fenced, hash-chained journal under the repository Git common
directory. Detached child attempts keep writing their own event files and can
be reconciled after the controller restarts.

## Documentation

- [Installation and setup](docs/installation.md)
- [Workflow DSL](docs/workflow-dsl.md)
- [Recovery and operations](docs/recovery.md)
- [Security model](SECURITY.md)
- [Release process](docs/releasing.md)

Remote access, Tailscale, dashboards, and multi-machine execution are outside
this release.
