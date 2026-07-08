# Agentic Delivery Workflow

A portable, file-based, agent-neutral software delivery workflow. It can be
copied into any repository so that Codex, Claude, Cursor, Copilot, a human, or a
CI job can all follow the same lifecycle, roles, rules, and proof gates from
plain repository files.

This repository is laid out exactly as an installed project: the workflow
package lives under [`harness/`](harness/README.md) and artifact templates live
under `docs/delivery/templates/`.

## Quick start

Install into another project with one of the CLI scripts:

```bash
./scripts/install-claude-workflow.sh /path/to/project   # Claude Code
./scripts/install-codex-workflow.sh  /path/to/project   # Codex
```

Both support `--force`, `--dry-run`, and a flag to skip runtime adapters
(`--no-commands` for Claude, `--no-skills` for Codex).

## Learn more

- [`harness/README.md`](harness/README.md) — what the workflow is and how the
  pieces fit together.
- [`harness/HOW_TO_USE.md`](harness/HOW_TO_USE.md) — choosing and composing
  flows.
- [`INSTALL.md`](INSTALL.md) — installation details and manual setup.

## Development

- `scripts/install-common.sh` holds the shared installer machinery; the two
  installers are thin wrappers over it.
- `tests/` contains the installer tests and a link checker that verifies every
  Markdown reference in an installed project resolves. Run them with:

```bash
sh tests/install_claude_workflow_test.sh
sh tests/install_codex_workflow_test.sh
sh tests/link_check_test.sh
```
