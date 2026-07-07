---
id: REQ-001
status: done
lane: normal
type: workflow-improvement
owner: intake
created: 2026-07-07
updated: 2026-07-07
depends_on: []
parallelizable: false
---

## Summary

Set up an install path for Codex equivalent to the existing Claude workflow
installer, after checking current Codex documentation.

## Source

Human request: "setup a way to install for Codex (likes we did with Claude).
Make sure you research Codex documentation before doing"

## Problem

The repository documents a Codex install path, but only Claude has a tested
installer script. Codex users must copy files and write adapters manually, which
creates drift from the documented workflow and from current Codex guidance.

## Desired Outcome

The repository provides a tested Codex installer that copies the base workflow
into a target repository, writes Codex-readable `AGENTS.md`, and optionally
adds small repo-scoped Codex skill adapters in the documented location.

## Audience Or Operator

Maintainers and agents installing this workflow into another repository for
Codex users.

## Current Behavior

`scripts/install-claude-workflow.sh` installs the workflow for Claude and is
covered by `tests/install_claude_workflow_test.sh`. Codex has documentation in
`INSTALL.md`, but no equivalent installer or test.

## Target Behavior

A sibling Codex installer supports normal install, overwrite protection,
`--force`, `--dry-run`, and an option to skip Codex skill adapters. Documentation
and adapter guidance match current Codex docs for repo-scoped skills.

## User Scenarios

### Scenario 1

- Priority: High
- Journey: A maintainer runs the Codex installer against a target repository and
  receives `AGENTS.md`, `harness/`, `docs/delivery/templates/`, experiment
  folders, and Codex skill adapters.
- Independent test: Shell installer test verifies expected files and adapter
  content.

### Scenario 2

- Priority: High
- Journey: A maintainer previews the install before changing a target
  repository.
- Independent test: Shell installer test verifies `--dry-run` prints planned
  writes and does not create files.

### Scenario 3

- Priority: Medium
- Journey: A target project wants only `AGENTS.md` and the base workflow, not
  Codex skill adapters.
- Independent test: Shell installer test verifies `--no-skills` skips
  `.agents/skills`.

## Edge Cases

- Refuse to install into the workflow source repository itself.
- Refuse to overwrite installed files unless `--force` is passed.
- Support a nested target path that does not already exist.

## Success Criteria

- `tests/install_codex_workflow_test.sh` passes.
- Existing Claude installer test still passes.
- `INSTALL.md`, `README.md`, and `adapters/agent-adapters.md` describe the
  Codex installer and current Codex adapter location.
- Trace records the Codex documentation source and proof run.

## Non-Goals

- Do not build a Codex plugin or marketplace package in this task.
- Do not change the Claude installer behavior except for shared documentation
  references if needed.
- Do not add runtime dependencies.

## Constraints

- Current Codex docs say repo-scoped skills belong under `.agents/skills`.
- The base workflow remains agent-neutral; Codex-specific files are adapters.
- The first target-project commit should contain only workflow files, not
  product code changes.

## Open Questions

- None blocking.
