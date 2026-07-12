#!/usr/bin/env sh
# Guards the agent/skill/rule/adapter wiring against silent drift.
#
# The MAP below is the single canonical statement of how each role is wired:
#   role | agent-file | skills (comma) | rules (comma) | adapter-slug
# For every role the test asserts:
#   - the agent file exists and references each listed skill and rule,
#   - each referenced skill and rule file exists,
#   - the role's adapter slug is in the installer's ADAPTER_SLUGS,
#   - HOW_TO_USE.md references each skill (the human-facing map stays in sync).
# It also checks every owner role in file-contracts.md (except human) has an
# agent file.
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
H="$ROOT_DIR/harness"
COMMON="$ROOT_DIR/scripts/install-common.sh"
HOW_TO_USE="$H/HOW_TO_USE.md"
fails=0

fail() {
  echo "MISALIGNED: $1" >&2
  fails=$((fails + 1))
}

# role | agent-file | skills | rules | adapter-slug
MAP='scope|scope-agent.md|scope|core-rules,risk-lanes|scope
orchestrator|orchestrator-agent.md|route|core-rules,risk-lanes,orchestration-rules,handoff-rules|route
planner|planner-agent.md|delivery-brief,task-planning|core-rules,risk-lanes,artifact-analysis,proof-gates,tdd-rules|plan
builder|builder-agent.md|debugging,research|core-rules,risk-lanes,proof-gates,tdd-rules|implement
reviewer|reviewer-agent.md|review|core-rules,risk-lanes,review-rules,proof-gates,tdd-rules|review
verifier|verifier-agent.md|verification|core-rules,risk-lanes,proof-gates,tdd-rules|verify
security|security-agent.md|security-audit|core-rules,risk-lanes,proof-gates|audit
qa|qa-agent.md|qa|core-rules,risk-lanes,proof-gates|qa
recorder|recorder-agent.md|record|core-rules,risk-lanes,handoff-rules,tdd-rules|record'

adapter_slugs=$(sed -n "s/^ADAPTER_SLUGS='\(.*\)'.*/\1/p" "$COMMON")
[ -n "$adapter_slugs" ] || fail "could not read ADAPTER_SLUGS from $COMMON"

# has_word LIST WORD -> true if WORD appears as a space-delimited token in LIST
has_word() {
  case " $1 " in
    *" $2 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Drive the loop from a temp file (not a pipe) so fail() updates this shell.
tmp_map="${TMPDIR:-/tmp}/harness-align-map.$$"
printf '%s\n' "$MAP" > "$tmp_map"

while IFS='|' read -r role agentfile skills rules slug; do
  [ -n "${role:-}" ] || continue

  agent="$H/agents/$agentfile"
  if [ ! -f "$agent" ]; then
    fail "$role: agent file missing ($agent)"
    continue
  fi

  old_ifs=$IFS
  IFS=,
  for s in $skills; do
    [ -f "$H/skills/$s.md" ] || fail "$role: skill file missing (harness/skills/$s.md)"
    grep -Fq "harness/skills/$s.md" "$agent" \
      || fail "$role: agent does not reference harness/skills/$s.md"
    # Builder's skills are task-specific (debugging/research) and are named in
    # flow recipes rather than the role/skill/rule map, so skip the map check.
    if [ "$role" != builder ]; then
      grep -Fq "harness/skills/$s.md" "$HOW_TO_USE" \
        || fail "$role: HOW_TO_USE.md does not reference harness/skills/$s.md"
    fi
  done
  for r in $rules; do
    [ -f "$H/rules/$r.md" ] || fail "$role: rule file missing (harness/rules/$r.md)"
    grep -Fq "harness/rules/$r.md" "$agent" \
      || fail "$role: agent does not reference harness/rules/$r.md"
  done
  IFS=$old_ifs

  has_word "$adapter_slugs" "$slug" \
    || fail "$role: adapter slug '$slug' not in ADAPTER_SLUGS"
done < "$tmp_map"

rm -f "$tmp_map"

# Every owner role (except human) in file-contracts.md must have an agent file.
for owner in orchestrator scope planner builder reviewer verifier security qa recorder; do
  grep -Fq -- "\`$owner\`" "$H/file-contracts.md" \
    || fail "owner '$owner' not listed in file-contracts.md"
  [ -f "$H/agents/$owner-agent.md" ] \
    || fail "owner '$owner' has no agent file"
done

if [ "$fails" -ne 0 ]; then
  echo "alignment_check_test: FAILED ($fails)" >&2
  exit 1
fi

echo "alignment_check_test: passed"
