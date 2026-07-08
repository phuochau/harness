#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage: install-codex-workflow.sh [--force] [--dry-run] [--no-skills] TARGET_DIR

Install this file-based agentic delivery workflow into a Codex project.

Options:
  --force       Overwrite installed workflow files in TARGET_DIR.
  --dry-run     Print planned actions without writing files.
  --no-skills   Do not create .agents/skills Codex adapter files.
  -h, --help    Show this help.
EOF
}

SOURCE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
FORCE=0
DRY_RUN=0
WITH_SKILLS=1
TARGET_DIR=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)     FORCE=1 ;;
    --dry-run)   DRY_RUN=1 ;;
    --no-skills) WITH_SKILLS=0 ;;
    -h|--help)   usage; exit 0 ;;
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

install_workflow() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would install Codex workflow into: $TARGET_ABS"
  else
    mkdir -p "$TARGET_ABS"
  fi

  write_agents_md
  install_harness_tree

  if [ "$WITH_SKILLS" -eq 1 ]; then
    install_adapters codex
  fi
}

install_workflow

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run complete."
else
  say "Codex workflow installed into: $TARGET_ABS"
fi
