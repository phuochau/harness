#!/usr/bin/env sh
# Installs the workflow with each installer and asserts that every inline
# Markdown reference to a package file (`...md`) resolves from the target root.
# This guards against the class of bug where copied docs reference paths that
# only exist in the source layout, not the installed layout.
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/harness-link-check.XXXXXX")

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

# check_tree ROOT
# Walks every .md file under ROOT and verifies each inline `path.md` reference
# (outside fenced code blocks) exists relative to ROOT. Bare root files such as
# AGENTS.md and CLAUDE.md resolve at ROOT too. Prints broken references and
# returns non-zero if any are found.
check_tree() {
  root=$1
  broken="$TMP_ROOT/broken.txt"
  : > "$broken"

  find "$root" -name '*.md' -print | while IFS= read -r file; do
    # Strip fenced code blocks so illustrative paths inside ``` are ignored,
    # then pull inline `...md` references and resolve each from the root.
    awk '/^[[:space:]]*```/ { fence = !fence; next } !fence { print }' "$file" \
      | grep -oE '`[A-Za-z0-9._/-]+\.md`' \
      | tr -d '`' \
      | while IFS= read -r ref; do
          # CLAUDE.md is an optional, runtime-specific entrypoint (Claude
          # installs only); shared docs may mention it even in a Codex tree.
          [ "$ref" = "CLAUDE.md" ] && continue
          if [ ! -f "$root/$ref" ]; then
            printf '%s -> %s\n' "${file#"$root"/}" "$ref" >> "$broken"
          fi
        done
  done

  if [ -s "$broken" ]; then
    echo "Broken Markdown references in $root:" >&2
    sort -u "$broken" >&2
    return 1
  fi
  return 0
}

status=0

claude_target="$TMP_ROOT/claude"
"$ROOT_DIR/scripts/install-claude-workflow.sh" "$claude_target" >/dev/null
if ! check_tree "$claude_target"; then
  status=1
fi

codex_target="$TMP_ROOT/codex"
"$ROOT_DIR/scripts/install-codex-workflow.sh" "$codex_target" >/dev/null
if ! check_tree "$codex_target"; then
  status=1
fi

if [ "$status" -ne 0 ]; then
  echo "link_check_test: FAILED" >&2
  exit 1
fi

echo "link_check_test: passed"
