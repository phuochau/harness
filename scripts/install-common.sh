# shellcheck shell=sh
# Shared machinery for the workflow installers.
#
# This file is sourced (not executed) by install-claude-workflow.sh and
# install-codex-workflow.sh. Those scripts parse their own runtime-specific
# flags, then rely on the helpers here for argument validation, target
# resolution, atomic copies, and installing the shared harness/ tree.
#
# Sourcing scripts must set before calling these helpers:
#   SOURCE_ROOT   absolute path to the workflow source repository
#   FORCE         0 or 1
#   DRY_RUN       0 or 1
#   TARGET_DIR    the raw target path from the CLI
# resolve_target sets TARGET_ABS.

say() {
  printf '%s\n' "$1"
}

# Validate TARGET_DIR and set TARGET_ABS to its absolute path.
resolve_target() {
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
    TARGET_ABS=$(CDPATH='' cd -- "$TARGET_DIR" && pwd -P)
  else
    case "$TARGET_DIR" in
      /*) TARGET_ABS=$TARGET_DIR ;;
      *)  TARGET_ABS=$(pwd -P)/$TARGET_DIR ;;
    esac
  fi

  if [ "$TARGET_ABS" = "$SOURCE_ROOT" ]; then
    echo "Refusing to install into the workflow source repository itself." >&2
    exit 1
  fi
}

ensure_available() {
  path=$1
  if [ -e "$path" ] && [ "$FORCE" -ne 1 ]; then
    echo "Refusing to overwrite existing path without --force: $path" >&2
    exit 1
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

# Copy a file, replacing atomically when --force is set (copy to a temp
# sibling, then mv over the destination) so the destination is never left
# missing if the copy fails midway.
copy_file() {
  src=$1
  dest=$2
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would copy file: $src -> $dest"
    return
  fi
  mkdir -p "$(dirname -- "$dest")"
  tmp="$dest.harness-tmp.$$"
  cp "$src" "$tmp"
  mv -f "$tmp" "$dest"
}

# Copy a directory tree, replacing atomically when --force is set.
copy_dir() {
  src=$1
  dest=$2
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would copy directory: $src -> $dest"
    return
  fi
  mkdir -p "$(dirname -- "$dest")"
  tmp="$dest.harness-tmp.$$"
  rm -rf "$tmp"
  cp -R "$src" "$tmp"
  rm -rf "$dest"
  mv -f "$tmp" "$dest"
}

# Write BODY to DEST, honoring --force and --dry-run, replacing atomically.
write_file() {
  dest=$1
  body=$2
  ensure_available "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Would write file: $dest"
    return
  fi
  mkdir -p "$(dirname -- "$dest")"
  tmp="$dest.harness-tmp.$$"
  printf '%s\n' "$body" > "$tmp"
  mv -f "$tmp" "$dest"
}

# The AGENTS.md entrypoint is identical for every runtime.
AGENTS_MD_BODY='# Agent Instructions

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
If the next step is unclear, use `harness/skills/route.md` and route
through `harness/agents/orchestrator-agent.md`.'

write_agents_md() {
  write_file "$TARGET_ABS/AGENTS.md" "$AGENTS_MD_BODY"
}

# Install the shared, runtime-neutral workflow files: the harness/ package
# (minus its internal REVIEW.md changelog), the artifact templates, the
# delivery output directories, and the experiments README.
install_harness_tree() {
  make_dir "$TARGET_ABS/docs/delivery"
  make_dir "$TARGET_ABS/experiments"
  for sub in requests briefs tasks experiments reviews verification traces decisions; do
    make_dir "$TARGET_ABS/docs/delivery/$sub"
  done

  # Copy the whole harness/ package, then drop the source-only changelog.
  copy_dir "$SOURCE_ROOT/harness" "$TARGET_ABS/harness"
  if [ "$DRY_RUN" -ne 1 ]; then
    rm -f "$TARGET_ABS/harness/REVIEW.md"
  fi

  copy_dir "$SOURCE_ROOT/docs/delivery/templates" "$TARGET_ABS/docs/delivery/templates"
  copy_file "$SOURCE_ROOT/experiments/README.md" "$TARGET_ABS/experiments/README.md"
}

# ---------------------------------------------------------------------------
# Runtime adapters
#
# Both runtimes expose the same canonical role set so behavior does not drift
# between Claude and Codex. The adapter body for each role is defined once; the
# only difference is how it is wrapped: a Claude slash command or a Codex skill.
# ---------------------------------------------------------------------------

ADAPTER_SLUGS='scope route plan implement review verify qa audit record'

adapter_desc() {
  case "$1" in
    scope)        echo 'Use when a request first enters the repository delivery workflow.' ;;
    route)     echo 'Use when the next action, role, lane, owner, proof, or escalation path is unclear.' ;;
    plan) echo 'Use after a request is clear enough for normal or high-risk delivery planning.' ;;
    implement)         echo 'Use when assigned a ready build, docs, investigation, or experiment task.' ;;
    review)        echo 'Use before integration or completion to review scope, proof, risk, and contracts.' ;;
    verify)        echo 'Use before claiming completion to run proof and record verification status.' ;;
    qa)            echo 'Use to validate a feature, release, or bug fix against acceptance criteria.' ;;
    audit)      echo 'Use for a security audit or a security-sensitive change.' ;;
    record)         echo 'Use at the end of work to write trace notes, decisions, and proof gaps.' ;;
  esac
}

adapter_title() {
  case "$1" in
    scope)        echo 'Scope' ;;
    route)     echo 'Route' ;;
    plan) echo 'Plan' ;;
    implement)         echo 'Implement' ;;
    review)        echo 'Review' ;;
    verify)        echo 'Verify' ;;
    qa)            echo 'QA' ;;
    audit)      echo 'Security Audit' ;;
    record)         echo 'Record' ;;
  esac
}

adapter_body() {
  case "$1" in
    scope) cat <<'EOF'
Use when a request first enters the workflow.

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/agents/scope-agent.md`
- `harness/skills/scope.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`

Create or update a request artifact from
`docs/delivery/templates/request.md` under `docs/delivery/requests/`.
EOF
    ;;
    route) cat <<'EOF'
Use when the next action, role, lane, owner, proof, or escalation path is
unclear.

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/skills/route.md`
- `harness/agents/orchestrator-agent.md`
- `harness/rules/orchestration-rules.md`
- `harness/rules/handoff-rules.md`

Return the next role, next skill, rule files to apply, required artifact, and
whether to continue, pause, escalate, or ask the human one concrete question.
EOF
    ;;
    plan) cat <<'EOF'
Use after a request is clear enough for normal or high-risk work.

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/agents/planner-agent.md`
- `harness/skills/delivery-brief.md`
- `harness/skills/task-planning.md`
- `harness/rules/artifact-analysis.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/delivery-brief.md`
- `docs/delivery/templates/task.md`

Write a delivery brief and task graph, then run artifact analysis before
implementation starts.
EOF
    ;;
    implement) cat <<'EOF'
Use when assigned a ready build, docs, investigation, or experiment task.

Read:

- `AGENTS.md`
- The assigned task and delivery brief.
- `harness/HOW_TO_USE.md`
- `harness/agents/builder-agent.md`
- `harness/rules/core-rules.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`

Implement only the assigned task. For production implementation, follow the
task TDD pairs or recorded exception. Run local proof where possible and update
handoff notes.
EOF
    ;;
    review) cat <<'EOF'
Use before integration or completion.

Read:

- `AGENTS.md`
- The request, brief, task, and diff.
- `harness/agents/reviewer-agent.md`
- `harness/skills/review.md`
- `harness/rules/review-rules.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/review.md`

Record a review decision: `approved`, `approved_with_risk`,
`changes_requested`, or `blocked`.
EOF
    ;;
    verify) cat <<'EOF'
Use before claiming work is complete.

Read:

- `AGENTS.md`
- The delivery brief, task, review artifact, and required proof.
- `harness/agents/verifier-agent.md`
- `harness/skills/verification.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/verification.md`

Run the relevant proof and record `passed`, `failed`, `blocked`,
`not_applicable`, or `risk_accepted`.
EOF
    ;;
    qa) cat <<'EOF'
Use to validate a feature, release, or bug fix against acceptance criteria.

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/agents/qa-agent.md`
- `harness/skills/qa.md`
- `harness/rules/proof-gates.md`
- `harness/rules/risk-lanes.md`
- `docs/delivery/templates/verification.md`

Start from the delivery brief, turn acceptance criteria into checks, run them,
and record `passed`, `failed`, `blocked`, `not_applicable`, or `risk_accepted`.
EOF
    ;;
    audit) cat <<'EOF'
Use for a security audit or a security-sensitive change.

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/agents/security-agent.md`
- `harness/skills/security-audit.md`
- `harness/rules/risk-lanes.md`
- `harness/rules/proof-gates.md`

Define scope, collect evidence, record findings separately from fixes, and
verify each fix. Treat the lane as high-risk unless explicitly narrowed.
EOF
    ;;
    record) cat <<'EOF'
Use at the end of work to record what happened and what future agents need.

Read:

- `AGENTS.md`
- The request, brief, tasks, review, and verification artifacts.
- `harness/agents/recorder-agent.md`
- `harness/skills/record.md`
- `harness/rules/handoff-rules.md`
- `harness/rules/tdd-rules.md`
- `docs/delivery/templates/trace.md`

Write or update the trace artifact with changed files, proof collected, review
result, remaining risk, workflow friction, and follow-up work.
EOF
    ;;
  esac
}

# Install the canonical adapter set in the given style: "claude" (slash
# commands under .claude/commands) or "codex" (skills under .agents/skills).
install_adapters() {
  style=$1
  # ADAPTER_SLUGS is a space-separated list; word splitting is intended.
  # shellcheck disable=SC2086
  for slug in $ADAPTER_SLUGS; do
    body=$(adapter_body "$slug")
    case "$style" in
      claude)
        write_file "$TARGET_ABS/.claude/commands/$slug.md" "# /$slug

$body"
        ;;
      codex)
        desc=$(adapter_desc "$slug")
        title=$(adapter_title "$slug")
        write_file "$TARGET_ABS/.agents/skills/$slug/SKILL.md" "---
name: $slug
description: $desc
---

# $title

$body"
        ;;
    esac
  done
}
