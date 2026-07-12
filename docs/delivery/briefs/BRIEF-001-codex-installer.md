---
id: BRIEF-001
status: done
lane: normal
owner: planner
request: REQ-001
created: 2026-07-07
updated: 2026-07-07
depends_on: []
parallelizable: false
---

## Outcome

Provide a tested Codex workflow installer that mirrors the Claude installer
where appropriate and follows current Codex documentation for repo guidance and
repo-scoped skills.

## Scope

- Add `scripts/install-codex-workflow.sh`.
- Add `tests/install_codex_workflow_test.sh`.
- Update installation and adapter documentation.
- Record review, verification, and trace artifacts for this normal-lane
  workflow change.

## Non-Goals

- No Codex plugin or marketplace packaging.
- No changes to workflow lifecycle semantics.
- No new external dependencies.
- No changes to product/runtime code outside this workflow repository.

## Current Behavior

Claude has a tested installer that creates `CLAUDE.md`, `AGENTS.md`, `harness/`,
delivery templates, experiment folders, and `.claude/commands/`. Codex users
only have manual instructions in `INSTALL.md`.

## Target Behavior

Codex has a tested installer that creates `AGENTS.md`, `harness/`,
`docs/delivery/templates/`, `docs/delivery/experiments/`,
`experiments/README.md`, and optional repo-scoped Codex skill adapters under
`.agents/skills/`.

## Acceptance Criteria

- The Codex installer installs the expected workflow files and Codex skill
  adapters into a target directory.
- The installer refuses to overwrite existing files unless `--force` is used.
- `--dry-run` prints planned writes without creating files.
- `--no-skills` installs the base workflow without `.agents/skills`.
- Documentation names the Codex installer and uses `.agents/skills` for
  repo-scoped Codex skills.
- The implementation records TDD red/green proof and final verification.

## Independent Test Scenarios

- Scenario:
  - Given: an empty temporary target repository
  - When: `scripts/install-codex-workflow.sh TARGET` runs
  - Then: the target has `AGENTS.md`, `harness/`, delivery templates,
    experiments, and `.agents/skills/*/SKILL.md`
  - Proof: `sh tests/install_codex_workflow_test.sh`

- Scenario:
  - Given: a target that was already installed
  - When: the installer runs again without `--force`
  - Then: it refuses to overwrite files
  - Proof: `sh tests/install_codex_workflow_test.sh`

- Scenario:
  - Given: a dry-run target
  - When: the installer runs with `--dry-run`
  - Then: it prints planned writes and does not create installed files
  - Proof: `sh tests/install_codex_workflow_test.sh`

- Scenario:
  - Given: a target that does not want skill adapters
  - When: the installer runs with `--no-skills`
  - Then: it installs the base workflow and does not create `.agents/skills`
  - Proof: `sh tests/install_codex_workflow_test.sh`

## Affected Surfaces

- Shell installer scripts and shell tests.
- Installation documentation.
- Adapter documentation.
- Delivery workflow artifacts.

## Risks

Normal lane. This is a bounded workflow/tooling change with file writes into
target repositories, overwrite behavior, and docs that must align with Codex
documentation.

## Required Proof

- `sh tests/install_codex_workflow_test.sh`
- `sh tests/install_claude_workflow_test.sh`
- Documentation inspection for Codex docs alignment.

## Artifact Analysis

- No unresolved clarification markers: yes.
- Every acceptance criterion has proof: yes.
- Production implementation tasks have TDD pairs or a recorded exception: yes,
  see `TASK-001`.
- Every task traces to the brief: yes.
- Every brief requirement has a task or explicit non-goal: yes.
- High-risk work is not hidden in a lower lane: yes.
- Non-goals are protected: yes.
- Parallel tasks have disjoint files, surfaces, or state: not applicable; one
  sequential task.
- Experiment tasks define hypothesis, success criteria, storage location,
  proof, and production-boundary rule: not applicable.

## Task Graph

- `TASK-001`: Add tested Codex workflow installer.

## Handoff Notes

Codex documentation was fetched from the official Codex manual on
2026-07-07. Relevant findings: Codex reads repo `AGENTS.md`; repo-scoped skills
belong under `.agents/skills`; plugins/marketplaces are the distribution unit
for broader sharing, but are out of scope for this installer.
