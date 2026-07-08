#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage: install-claude-workflow.sh [--force] [--dry-run] [--no-commands] TARGET_DIR

Install this file-based agentic delivery workflow into a Claude Code project.

Options:
  --force        Overwrite installed workflow files in TARGET_DIR.
  --dry-run      Print planned actions without writing files.
  --no-commands  Do not create .claude/commands adapter files.
  -h, --help     Show this help.
EOF
}

SOURCE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
FORCE=0
DRY_RUN=0
WITH_COMMANDS=1
TARGET_DIR=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)       FORCE=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    --no-commands) WITH_COMMANDS=0 ;;
    -h|--help)     usage; exit 0 ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$TARGET_DIR" ]; then
        echo "Unexpected extra argument: $1" >&2
        usage >&2
        exit 2
      fi
      TARGET_DIR=$1
      ;;
  esac
  shift
done

# shellcheck source=scripts/install-common.sh
. "$SOURCE_ROOT/scripts/install-common.sh"

resolve_target

CLAUDE_MD_BODY='# Claude Instructions

This repository uses an agentic delivery workflow.

Before changing code, read:

- `AGENTS.md`
- `harness/README.md`
- `harness/HOW_TO_USE.md`
- `harness/influence-map.md`
- `harness/file-contracts.md`
- `harness/rules/core-rules.md`
- `harness/rules/orchestration-rules.md`
- `harness/rules/risk-lanes.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`
- `harness/rules/artifact-analysis.md`
- `harness/rules/handoff-rules.md`

Use roles from `harness/agents/`, skills from `harness/skills/`,
rules from `harness/rules/`, and templates from
`docs/delivery/templates/`. Use the role/skill/rule map in
`harness/HOW_TO_USE.md` when the artifact does not already name the
owner.

If the next step is unclear, use `harness/skills/next-step.md` and ask
the Orchestrator Agent in `harness/agents/orchestrator-agent.md`.'

install_workflow() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would install Claude workflow into: $TARGET_ABS"
  else
    mkdir -p "$TARGET_ABS"
  fi

  write_file "$TARGET_ABS/CLAUDE.md" "$CLAUDE_MD_BODY"
  write_agents_md
  install_harness_tree

  if [ "$WITH_COMMANDS" -eq 1 ]; then
    install_adapters claude
  fi
}

install_workflow

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run complete."
else
  say "Installed Claude workflow into: $TARGET_ABS"
fi
