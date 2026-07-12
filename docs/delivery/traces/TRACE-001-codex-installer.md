---
id: TRACE-001
status: done
lane: normal
owner: recorder
request: REQ-001
brief: BRIEF-001
created: 2026-07-07
updated: 2026-07-07
---

## Summary

Added a tested Codex installer that copies the base workflow into a target
repository, writes Codex-readable `AGENTS.md`, and optionally creates
repo-scoped skill adapters under `.agents/skills`.

## Files Or Surfaces Read

- `README.md`
- `HOW_TO_USE.md`
- `workflow/influence-map.md`
- `workflow/file-contracts.md`
- `rules/core-rules.md`
- `rules/orchestration-rules.md`
- `rules/risk-lanes.md`
- `rules/proof-gates.md`
- `rules/tdd-rules.md`
- `rules/artifact-analysis.md`
- `rules/handoff-rules.md`
- `INSTALL.md`
- `scripts/install-claude-workflow.sh`
- `tests/install_claude_workflow_test.sh`
- `adapters/agent-adapters.md`
- Official Codex manual, fetched 2026-07-07:
  - `https://developers.openai.com/codex/guides/agents-md`
  - `https://developers.openai.com/codex/concepts/customization`
  - `https://developers.openai.com/codex/plugins`
  - `https://developers.openai.com/codex/plugins/build`

## Files Or Surfaces Changed

- `README.md`
- `INSTALL.md`
- `REVIEW.md`
- `adapters/agent-adapters.md`
- `scripts/install-codex-workflow.sh`
- `tests/install_codex_workflow_test.sh`
- `docs/delivery/requests/REQ-001-codex-installer.md`
- `docs/delivery/briefs/BRIEF-001-codex-installer.md`
- `docs/delivery/tasks/TASK-001-codex-installer.md`
- `docs/delivery/reviews/REVIEW-001-codex-installer.md`
- `docs/delivery/verification/VERIFY-001-codex-installer.md`
- `docs/delivery/traces/TRACE-001-codex-installer.md`

## Decisions Made

- Use `AGENTS.md` for the required Codex instruction surface.
- Use `.agents/skills` for checked-in repo-scoped Codex skill adapters.
- Keep Codex plugin and marketplace packaging out of scope for this installer.
- Keep the installer agent-neutral except for optional Codex adapter files.

## Experiment Results

- None.

## Source Traceability

- Request: `docs/delivery/requests/REQ-001-codex-installer.md`
- Brief: `docs/delivery/briefs/BRIEF-001-codex-installer.md`
- Tasks: `docs/delivery/tasks/TASK-001-codex-installer.md`
- Review: `docs/delivery/reviews/REVIEW-001-codex-installer.md`
- Verification: `docs/delivery/verification/VERIFY-001-codex-installer.md`
- Experiments: not applicable.

## Proof Collected

- TDD red: `sh tests/install_codex_workflow_test.sh` failed because
  `scripts/install-codex-workflow.sh` did not exist.
- TDD green: `sh tests/install_codex_workflow_test.sh` passed.
- Final Codex proof: `sh tests/install_codex_workflow_test.sh` passed.
- Claude regression proof: `sh tests/install_claude_workflow_test.sh` passed.
- Whitespace proof: `git diff --check` passed.
- Documentation path check: search confirmed `.agents/skills` is the documented
  and implemented Codex adapter path. Install docs, adapter docs, and the Codex
  installer do not use `.codex/skills`.

## Review Result

`approved`

## Remaining Risk

No known remaining risk for the requested installer. The installer does not
attempt plugin or marketplace distribution; that is an explicit non-goal.

## Workflow Friction

The repository already had a Codex manual install sketch, but it used an older
`.codex/skills` adapter path. Researching the official Codex manual changed the
implementation to `.agents/skills`.

## Follow-Up Work

- Consider a separate Codex plugin or marketplace task only if broader team or
  reusable distribution becomes necessary.
