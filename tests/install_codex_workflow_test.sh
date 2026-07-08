#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
INSTALLER="$ROOT_DIR/scripts/install-codex-workflow.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/harness-codex-install.XXXXXX")

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

assert_file() {
  if [ ! -f "$1" ]; then
    echo "Expected file missing: $1" >&2
    exit 1
  fi
}

assert_dir() {
  if [ ! -d "$1" ]; then
    echo "Expected directory missing: $1" >&2
    exit 1
  fi
}

assert_absent() {
  if [ -e "$1" ]; then
    echo "Expected path to be absent: $1" >&2
    exit 1
  fi
}

assert_contains() {
  file=$1
  pattern=$2
  if ! grep -Fq -- "$pattern" "$file"; then
    echo "Expected pattern missing in $file: $pattern" >&2
    exit 1
  fi
}

target="$TMP_ROOT/project"
dry_target="$TMP_ROOT/dry-project"
no_skills_target="$TMP_ROOT/no-skills-project"
nested_target="$TMP_ROOT/nested/codex/project"
second_run_output="$TMP_ROOT/second-run.out"
dry_run_output="$TMP_ROOT/dry-run.out"

mkdir -p "$target" "$dry_target" "$no_skills_target"
dry_target_abs=$(CDPATH='' cd -- "$dry_target" && pwd -P)

"$INSTALLER" "$target"

assert_file "$target/AGENTS.md"
assert_absent "$target/CLAUDE.md"
assert_file "$target/harness/README.md"
assert_file "$target/harness/HOW_TO_USE.md"
assert_file "$target/harness/influence-map.md"
assert_file "$target/harness/file-contracts.md"
assert_file "$target/harness/agents/builder-agent.md"
assert_file "$target/harness/skills/next-step.md"
assert_file "$target/harness/rules/tdd-rules.md"
assert_file "$target/harness/adapters/agent-adapters.md"
assert_absent "$target/harness/REVIEW.md"
assert_file "$target/docs/delivery/templates/task.md"
assert_dir "$target/docs/delivery/requests"
assert_dir "$target/docs/delivery/experiments"
assert_dir "$target/docs/delivery/decisions"
assert_file "$target/experiments/README.md"
assert_absent "$target/.claude"
assert_absent "$target/.codex/skills"

# Canonical adapter set (same role set as the Claude installer).
for slug in intake next-step plan-delivery build review verify qa security trace; do
  assert_file "$target/.agents/skills/$slug/SKILL.md"
done

assert_contains "$target/AGENTS.md" "harness/HOW_TO_USE.md"
assert_contains "$target/AGENTS.md" "role/skill/rule map"
assert_contains "$target/.agents/skills/intake/SKILL.md" "name: intake"
assert_contains "$target/.agents/skills/intake/SKILL.md" "harness/skills/intake.md"
assert_contains "$target/.agents/skills/next-step/SKILL.md" "name: next-step"
assert_contains "$target/.agents/skills/next-step/SKILL.md" "harness/agents/orchestrator-agent.md"
assert_contains "$target/.agents/skills/plan-delivery/SKILL.md" "harness/skills/delivery-brief.md"
assert_contains "$target/.agents/skills/plan-delivery/SKILL.md" "harness/skills/task-planning.md"
assert_contains "$target/.agents/skills/build/SKILL.md" "harness/agents/builder-agent.md"
assert_contains "$target/.agents/skills/build/SKILL.md" "harness/rules/tdd-rules.md"
assert_contains "$target/.agents/skills/review/SKILL.md" "harness/skills/review.md"
assert_contains "$target/.agents/skills/verify/SKILL.md" "harness/skills/verification.md"
assert_contains "$target/.agents/skills/trace/SKILL.md" "harness/skills/trace.md"

if "$INSTALLER" "$target" >"$second_run_output" 2>&1; then
  echo "Expected second install without --force to fail" >&2
  exit 1
fi
assert_contains "$second_run_output" "Refusing to overwrite existing path without --force"

"$INSTALLER" --force "$target"

"$INSTALLER" --dry-run "$dry_target" >"$dry_run_output"
assert_contains "$dry_run_output" "Would install Codex workflow"
assert_contains "$dry_run_output" "Would write file: $dry_target_abs/AGENTS.md"
assert_contains "$dry_run_output" "Would write file: $dry_target_abs/.agents/skills/next-step/SKILL.md"
assert_absent "$dry_target/AGENTS.md"

"$INSTALLER" --no-skills "$no_skills_target"
assert_file "$no_skills_target/AGENTS.md"
assert_file "$no_skills_target/harness/HOW_TO_USE.md"
assert_absent "$no_skills_target/.agents/skills"

"$INSTALLER" "$nested_target"
assert_file "$nested_target/AGENTS.md"
assert_file "$nested_target/harness/README.md"
assert_file "$nested_target/.agents/skills/next-step/SKILL.md"

echo "install_codex_workflow_test: passed"
