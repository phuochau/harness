---
id: TASK-001
status: done
lane: normal
type: build
owner: builder
brief: BRIEF-001
created: 2026-07-07
updated: 2026-07-07
depends_on: []
parallelizable: false
proof_required:
  - sh tests/install_codex_workflow_test.sh
  - sh tests/install_claude_workflow_test.sh
---

## Goal

Add a tested Codex installer that mirrors the Claude installer while using
current Codex repo-scoped skill conventions.

## Trace To Source

`REQ-001`, `BRIEF-001`, and all acceptance criteria in
`docs/delivery/briefs/BRIEF-001-codex-installer.md`.

## Inputs

- `docs/delivery/requests/REQ-001-codex-installer.md`
- `docs/delivery/briefs/BRIEF-001-codex-installer.md`
- `scripts/install-claude-workflow.sh`
- `tests/install_claude_workflow_test.sh`
- `INSTALL.md`
- `README.md`
- `adapters/agent-adapters.md`
- Official Codex manual sections for `AGENTS.md`, customization, skills, and
  plugins.

## Expected Changes

- Create `scripts/install-codex-workflow.sh`.
- Create `tests/install_codex_workflow_test.sh`.
- Update docs to mention the tested Codex installer and `.agents/skills`
  adapters.
- Add review, verification, and trace artifacts after implementation.

## Out Of Scope

- Do not create a Codex plugin, plugin marketplace, or MCP integration.
- Do not change Claude installer behavior.
- Do not add dependencies beyond POSIX shell utilities already used by the
  Claude installer.

## Steps

1. Add the failing shell test for Codex install behavior.
2. Run `sh tests/install_codex_workflow_test.sh` and confirm it fails because
   the Codex installer is missing.
3. Add the smallest Codex installer implementation that satisfies the test.
4. Run `sh tests/install_codex_workflow_test.sh` and confirm it passes.
5. Update `INSTALL.md`, `README.md`, and `adapters/agent-adapters.md` to match
   the implemented Codex install path.
6. Run both installer tests.
7. Record review, verification, and trace artifacts.

For production implementation, use this TDD pair:

- Failing proof: `tests/install_codex_workflow_test.sh` expects
  `scripts/install-codex-workflow.sh` to install Codex workflow files and
  optional `.agents/skills` adapters.
- Production behavior: `scripts/install-codex-workflow.sh` implements normal
  install, overwrite protection, `--force`, `--dry-run`, `--no-skills`, nested
  target creation, and source-repo refusal.
- Red command or check: `sh tests/install_codex_workflow_test.sh`
- Green command or check: `sh tests/install_codex_workflow_test.sh`

Docs-only updates are covered by a TDD exception because they do not add runtime
behavior. Replacement proof: inspect changed documentation and run both
installer tests to ensure documented files exist.

## Proof Required

- `sh tests/install_codex_workflow_test.sh`
- `sh tests/install_claude_workflow_test.sh`

## Parallel Safety

Not parallelizable. The installer, docs, and tests describe the same workflow
surface and should change together.

## Handoff Notes

Review should check the Codex docs alignment specifically: repo-scoped skill
adapters should be under `.agents/skills`, while plugin/marketplace packaging
remains a documented future option rather than part of this install script.

## Blockers

None.
