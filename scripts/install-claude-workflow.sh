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

SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
FORCE=0
DRY_RUN=0
WITH_COMMANDS=1
TARGET_DIR=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --no-commands)
      WITH_COMMANDS=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
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

if [ -z "$TARGET_DIR" ]; then
  echo "TARGET_DIR is required." >&2
  usage >&2
  exit 2
fi

if [ -e "$TARGET_DIR" ] && [ ! -d "$TARGET_DIR" ]; then
  echo "TARGET_DIR exists but is not a directory: $TARGET_DIR" >&2
  exit 1
fi

if [ -d "$TARGET_DIR" ]; then
  TARGET_ABS=$(CDPATH= cd -- "$TARGET_DIR" && pwd -P)
else
  case "$TARGET_DIR" in
    /*)
      TARGET_ABS=$TARGET_DIR
      ;;
    *)
      TARGET_ABS=$(pwd -P)/$TARGET_DIR
      ;;
  esac
fi

if [ "$TARGET_ABS" = "$SOURCE_ROOT" ]; then
  echo "Refusing to install into the workflow source repository itself." >&2
  exit 1
fi

say() {
  printf '%s\n' "$1"
}

ensure_available() {
  path=$1
  if [ -e "$path" ] && [ "$FORCE" -ne 1 ]; then
    echo "Refusing to overwrite existing path without --force: $path" >&2
    exit 1
  fi
}

remove_existing_if_forced() {
  path=$1
  if [ -e "$path" ] && [ "$FORCE" -eq 1 ]; then
    rm -rf "$path"
  fi
}

make_dir() {
  path=$1
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would create directory: $path"
  else
    mkdir -p "$path"
  fi
}

copy_file() {
  src=$1
  dest=$2
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would copy file: $src -> $dest"
  else
    mkdir -p "$(dirname -- "$dest")"
    remove_existing_if_forced "$dest"
    cp "$src" "$dest"
  fi
}

copy_dir() {
  src=$1
  dest=$2
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would copy directory: $src -> $dest"
  else
    mkdir -p "$(dirname -- "$dest")"
    remove_existing_if_forced "$dest"
    cp -R "$src" "$dest"
  fi
}

write_claude_md() {
  dest=$TARGET_ABS/CLAUDE.md
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would write file: $dest"
    return
  fi
  mkdir -p "$(dirname -- "$dest")"
  remove_existing_if_forced "$dest"
  cat > "$dest" <<'EOF'
# Claude Instructions

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
the Orchestrator Agent in `harness/agents/orchestrator-agent.md`.
EOF
}

write_agents_md() {
  dest=$TARGET_ABS/AGENTS.md
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would write file: $dest"
    return
  fi
  mkdir -p "$(dirname -- "$dest")"
  remove_existing_if_forced "$dest"
  cat > "$dest" <<'EOF'
# Agent Instructions

This repository uses an agentic delivery workflow. Before changing code, read:

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

Choose a role from `harness/agents/`, run the matching skill from
`harness/skills/`, and use the role/skill/rule map in
`harness/HOW_TO_USE.md` when the artifact does not already name the
owner. Write artifacts from `docs/delivery/templates/`.
If the next step is unclear, use `harness/skills/next-step.md` and route
through `harness/agents/orchestrator-agent.md`.
EOF
}

write_command() {
  name=$1
  body=$2
  dest=$TARGET_ABS/.claude/commands/$name.md
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would write file: $dest"
    return
  fi
  mkdir -p "$(dirname -- "$dest")"
  remove_existing_if_forced "$dest"
  printf '%s\n' "$body" > "$dest"
}

write_claude_commands() {
  write_command intake '# /intake

Use when a request first enters the workflow.

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/agents/intake-agent.md`
- `harness/skills/intake.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`

Create or update a request artifact from
`docs/delivery/templates/request.md`.
'

  write_command next-step '# /next-step

Use when the next action, role, lane, owner, proof, or escalation path is
unclear.

Read:

- `harness/HOW_TO_USE.md`
- `harness/skills/next-step.md`
- `harness/agents/orchestrator-agent.md`
- `harness/rules/orchestration-rules.md`
- `harness/rules/handoff-rules.md`

Return:

- Next role.
- Next skill.
- Rule files to apply.
- Required artifact.
- Whether to continue, pause, escalate, or ask the human one concrete question.
'

  write_command plan-delivery '# /plan-delivery

Use after a request is clear enough for normal or high-risk work.

Read:

- `harness/HOW_TO_USE.md`
- `harness/agents/delivery-planner-agent.md`
- `harness/skills/delivery-brief.md`
- `harness/skills/task-planning.md`
- `harness/rules/artifact-analysis.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/delivery-brief.md`
- `docs/delivery/templates/task.md`

Write a delivery brief and task graph, then run artifact analysis before
implementation.
'

  write_command review-task '# /review-task

Use before integration or completion.

Read:

- The request, brief, task, and diff.
- `harness/agents/reviewer-agent.md`
- `harness/skills/review.md`
- `harness/rules/review-rules.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/review.md`

Record a review decision: `approved`, `approved_with_risk`,
`changes_requested`, or `blocked`.
'

  write_command verify-task '# /verify-task

Use before claiming work is complete.

Read:

- The delivery brief, task, review artifact, and required proof.
- `harness/agents/verifier-agent.md`
- `harness/skills/verification.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/verification.md`

Run the relevant proof and record `passed`, `failed`, `blocked`,
`not_applicable`, or `risk_accepted`.
'
}

install_workflow() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would install Claude workflow into: $TARGET_ABS"
  else
    mkdir -p "$TARGET_ABS"
  fi

  make_dir "$TARGET_ABS/harness"
  make_dir "$TARGET_ABS/docs/delivery"
  make_dir "$TARGET_ABS/docs/delivery/experiments"
  make_dir "$TARGET_ABS/experiments"

  write_claude_md
  write_agents_md

  copy_file "$SOURCE_ROOT/README.md" "$TARGET_ABS/harness/README.md"
  copy_file "$SOURCE_ROOT/HOW_TO_USE.md" "$TARGET_ABS/harness/HOW_TO_USE.md"
  copy_file "$SOURCE_ROOT/REVIEW.md" "$TARGET_ABS/harness/REVIEW.md"
  copy_file "$SOURCE_ROOT/workflow/influence-map.md" "$TARGET_ABS/harness/influence-map.md"
  copy_file "$SOURCE_ROOT/workflow/file-contracts.md" "$TARGET_ABS/harness/file-contracts.md"
  copy_file "$SOURCE_ROOT/workflow/principles.md" "$TARGET_ABS/harness/principles.md"
  copy_file "$SOURCE_ROOT/workflow/lifecycle.md" "$TARGET_ABS/harness/lifecycle.md"
  copy_file "$SOURCE_ROOT/experiments/README.md" "$TARGET_ABS/experiments/README.md"

  copy_dir "$SOURCE_ROOT/agents" "$TARGET_ABS/harness/agents"
  copy_dir "$SOURCE_ROOT/skills" "$TARGET_ABS/harness/skills"
  copy_dir "$SOURCE_ROOT/rules" "$TARGET_ABS/harness/rules"
  copy_dir "$SOURCE_ROOT/adapters" "$TARGET_ABS/harness/adapters"
  copy_dir "$SOURCE_ROOT/templates" "$TARGET_ABS/docs/delivery/templates"

  if [ "$WITH_COMMANDS" -eq 1 ]; then
    write_claude_commands
  fi
}

install_workflow

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run complete."
else
  say "Installed Claude workflow into: $TARGET_ABS"
fi
