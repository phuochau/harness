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

SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
FORCE=0
DRY_RUN=0
WITH_SKILLS=1
TARGET_DIR=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --no-skills)
      WITH_SKILLS=0
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

write_skill() {
  name=$1
  body=$2
  dest=$TARGET_ABS/.agents/skills/$name/SKILL.md
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would write file: $dest"
    return
  fi
  mkdir -p "$(dirname -- "$dest")"
  remove_existing_if_forced "$dest"
  printf '%s\n' "$body" > "$dest"
}

write_codex_skills() {
  write_skill intake '---
name: intake
description: Use when a request first enters the repository delivery workflow.
---

# Intake

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/agents/intake-agent.md`
- `harness/skills/intake.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`
- `docs/delivery/templates/request.md`

Then create or update a request artifact under `docs/delivery/requests/`.
'

  write_skill next-step '---
name: next-step
description: Use when the next role, lane, owner, proof, or escalation path is unclear.
---

# Next Step

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/skills/next-step.md`
- `harness/agents/orchestrator-agent.md`
- `harness/rules/orchestration-rules.md`
- `harness/rules/handoff-rules.md`

Return the next role, next skill, rule files to apply, required artifact, and
whether to continue, pause, escalate, or ask the human one concrete question.
'

  write_skill delivery-planner '---
name: delivery-planner
description: Use after a request is clear enough for normal or high-risk delivery planning.
---

# Delivery Planner

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/agents/delivery-planner-agent.md`
- `harness/skills/delivery-brief.md`
- `harness/skills/task-planning.md`
- `harness/rules/artifact-analysis.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/delivery-brief.md`
- `docs/delivery/templates/task.md`

Write a delivery brief and task graph, then run artifact analysis before
implementation starts.
'

  write_skill builder '---
name: builder
description: Use when assigned a ready build, docs, investigation, or experiment task.
---

# Builder

Read:

- `AGENTS.md`
- The assigned task and delivery brief
- `harness/HOW_TO_USE.md`
- `harness/agents/builder-agent.md`
- `harness/rules/core-rules.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`

Implement only the assigned task. For production implementation, follow the
task TDD pairs or recorded exception. Run local proof where possible and update
handoff notes.
'

  write_skill reviewer '---
name: reviewer
description: Use before integration or completion to review scope, proof, risk, and contracts.
---

# Reviewer

Read:

- `AGENTS.md`
- The request, brief, task, and diff
- `harness/agents/reviewer-agent.md`
- `harness/skills/review.md`
- `harness/rules/review-rules.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/review.md`

Record a review decision: `approved`, `approved_with_risk`,
`changes_requested`, or `blocked`.
'

  write_skill verifier '---
name: verifier
description: Use before claiming completion to run proof and record verification status.
---

# Verifier

Read:

- `AGENTS.md`
- The delivery brief, task, review artifact, and required proof
- `harness/agents/verifier-agent.md`
- `harness/skills/verification.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/verification.md`

Run the relevant proof and record `passed`, `failed`, `blocked`,
`not_applicable`, or `risk_accepted`.
'

  write_skill historian '---
name: historian
description: Use at the end of work to write trace notes, decisions, and proof gaps.
---

# Historian

Read:

- `AGENTS.md`
- The request, brief, tasks, review, and verification artifacts
- `harness/agents/historian-agent.md`
- `harness/skills/trace.md`
- `harness/rules/handoff-rules.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/trace.md`

Write or update the trace artifact with changed files, proof collected, review
result, remaining risk, workflow friction, and follow-up work.
'
}

install_workflow() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would install Codex workflow into: $TARGET_ABS"
  else
    mkdir -p "$TARGET_ABS"
  fi

  make_dir "$TARGET_ABS/harness"
  make_dir "$TARGET_ABS/docs/delivery"
  make_dir "$TARGET_ABS/docs/delivery/experiments"
  make_dir "$TARGET_ABS/experiments"

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

  if [ "$WITH_SKILLS" -eq 1 ]; then
    write_codex_skills
  fi
}

install_workflow

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run complete."
else
  say "Codex workflow installed into: $TARGET_ABS"
fi
