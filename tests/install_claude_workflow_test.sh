#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
INSTALLER="$ROOT_DIR/scripts/install-claude-workflow.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/harness-claude-install.XXXXXX")

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
no_commands_target="$TMP_ROOT/no-commands-project"
nested_target="$TMP_ROOT/nested/claude/project"

mkdir -p "$target" "$dry_target" "$no_commands_target"

"$INSTALLER" "$target"

assert_file "$target/CLAUDE.md"
assert_file "$target/AGENTS.md"
assert_file "$target/harness/README.md"
assert_file "$target/harness/HOW_TO_USE.md"
assert_file "$target/harness/influence-map.md"
assert_file "$target/harness/file-contracts.md"
assert_file "$target/harness/agents/builder-agent.md"
assert_file "$target/harness/skills/next-step.md"
assert_file "$target/harness/rules/tdd-rules.md"
assert_file "$target/harness/adapters/agent-adapters.md"
# The internal changelog must not ship to installed projects.
assert_absent "$target/harness/REVIEW.md"
if [ -e "$target/docs/workflow" ]; then
  echo "Installer should use harness/, not docs/workflow/" >&2
  exit 1
fi
assert_file "$target/docs/delivery/templates/task.md"
assert_dir "$target/docs/delivery/requests"
assert_dir "$target/docs/delivery/experiments"
assert_dir "$target/docs/delivery/decisions"
assert_file "$target/experiments/README.md"

# Canonical adapter set (same role set as the Codex installer).
for slug in intake next-step plan-delivery build review verify qa security trace; do
  assert_file "$target/.claude/commands/$slug.md"
done

assert_contains "$target/CLAUDE.md" "harness/HOW_TO_USE.md"
assert_contains "$target/CLAUDE.md" "role/skill/rule map"
assert_contains "$target/AGENTS.md" "harness/HOW_TO_USE.md"
assert_contains "$target/.claude/commands/next-step.md" "rule files to apply"
assert_contains "$target/.claude/commands/next-step.md" "harness/skills/next-step.md"

if "$INSTALLER" "$target" >"$TMP_ROOT/second-run.out" 2>&1; then
  echo "Expected second install without --force to fail" >&2
  exit 1
fi
assert_contains "$TMP_ROOT/second-run.out" "Refusing to overwrite existing path without --force"

"$INSTALLER" --force "$target"

"$INSTALLER" --dry-run "$dry_target" >"$TMP_ROOT/dry-run.out"
assert_contains "$TMP_ROOT/dry-run.out" "Would install Claude workflow"
if [ -e "$dry_target/CLAUDE.md" ]; then
  echo "Dry run should not create CLAUDE.md" >&2
  exit 1
fi

"$INSTALLER" --no-commands "$no_commands_target"
assert_file "$no_commands_target/CLAUDE.md"
assert_file "$no_commands_target/harness/HOW_TO_USE.md"
assert_absent "$no_commands_target/.claude/commands"

"$INSTALLER" "$nested_target"
assert_file "$nested_target/CLAUDE.md"
assert_file "$nested_target/harness/README.md"

echo "install_claude_workflow_test: passed"
