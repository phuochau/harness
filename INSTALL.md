# Copying This Workflow Into Another Project

This workflow package is intentionally file-based. It does not require a CLI,
database, hosted service, or specific coding agent. The Claude installer script
only automates the file copy and adapter setup described below.

## Minimal Install

Create this layout in the target repository:

```text
AGENTS.md
harness/
docs/delivery/
docs/delivery/experiments/
experiments/
```

Recommended mapping from this repository:

```text
AGENTS.md              -> AGENTS.md
README.md              -> harness/README.md
HOW_TO_USE.md          -> harness/HOW_TO_USE.md
agents/*               -> harness/agents/*
skills/*               -> harness/skills/*
rules/*                -> harness/rules/*
workflow/*             -> harness/*
templates/*            -> docs/delivery/templates/*
adapters/*             -> harness/adapters/*
experiments/README.md  -> experiments/README.md
```

Then update `AGENTS.md` paths to match the target project layout. If the
workflow files live under `harness/`, use the sample `AGENTS.md` section
below.

Also keep `REVIEW.md` in this source repository or copy it to
`harness/REVIEW.md` if the target project wants an audit trail for why the
workflow exists.

## Keep It Agent-Neutral

Do not make Codex, Claude, Cursor, or Copilot the source of truth. Add adapter
files only after the base workflow works as plain repo files.

## Install For Claude With The CLI

From this workflow repository, run:

```bash
./scripts/install-claude-workflow.sh /path/to/claude-project
```

The installer creates:

- `CLAUDE.md`
- `AGENTS.md`
- `harness/`
- `docs/delivery/templates/`
- `docs/delivery/experiments/`
- `experiments/README.md`
- `.claude/commands/` command adapters

The script refuses to overwrite existing installed files unless `--force` is
provided:

```bash
./scripts/install-claude-workflow.sh --force /path/to/claude-project
```

Preview the planned writes without changing the target project:

```bash
./scripts/install-claude-workflow.sh --dry-run /path/to/claude-project
```

Skip Claude command adapters when the target project only wants `CLAUDE.md` and
the workflow files:

```bash
./scripts/install-claude-workflow.sh --no-commands /path/to/claude-project
```

After install, review the generated `CLAUDE.md` and `AGENTS.md` before mixing
the workflow install with product code changes.

## Install For Codex

Codex can use the base install directly because it reads `AGENTS.md`.

Minimum Codex install:

```text
AGENTS.md
harness/
docs/delivery/templates/
docs/delivery/experiments/
experiments/
```

Recommended `AGENTS.md` entry for a target project:

```markdown
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
```

Optional Codex skill adapters:

```text
.codex/skills/intake/SKILL.md
.codex/skills/next-step/SKILL.md
.codex/skills/delivery-planner/SKILL.md
.codex/skills/builder/SKILL.md
.codex/skills/reviewer/SKILL.md
.codex/skills/verifier/SKILL.md
.codex/skills/historian/SKILL.md
```

Each adapter should be small. It should point Codex back to the generic files
under `harness/agents/`, `harness/skills/`, and
`harness/rules/`.

Example Codex adapter body:

```markdown
# Intake

Use this skill when a request first enters the workflow.

Read:

- `AGENTS.md`
- `harness/HOW_TO_USE.md`
- `harness/agents/intake-agent.md`
- `harness/skills/intake.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`

Then create or update a request artifact from
`docs/delivery/templates/request.md`.
```

## Install For Claude

Claude Code does not automatically use `AGENTS.md` in the same way Codex does,
so add a `CLAUDE.md` that points Claude to the same source-of-truth files.

Minimum Claude install:

```text
CLAUDE.md
AGENTS.md
harness/
docs/delivery/templates/
docs/delivery/experiments/
experiments/
```

Recommended `CLAUDE.md`:

```markdown
# Claude Instructions

This repository uses an agentic delivery workflow.

Before changing code, read:

- `AGENTS.md`
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

Use roles from `harness/agents/`, skills from `harness/skills/`,
rules from `harness/rules/`, and templates from
`docs/delivery/templates/`. Use the role/skill/rule map in
`harness/HOW_TO_USE.md` when the artifact does not already name the
owner.

If the next step is unclear, use `harness/skills/next-step.md` and ask
the Orchestrator Agent in `harness/agents/orchestrator-agent.md`.
```

Optional Claude command adapters:

```text
.claude/commands/intake.md
.claude/commands/next-step.md
.claude/commands/plan-delivery.md
.claude/commands/review-task.md
.claude/commands/verify-task.md
```

Example Claude command body:

```markdown
# /next-step

Use when the next action, role, lane, owner, or proof is unclear.

Read:

- `harness/skills/next-step.md`
- `harness/agents/orchestrator-agent.md`
- `harness/rules/orchestration-rules.md`

Return the next role, next skill, required artifact, and whether to continue,
pause, escalate, or ask the human one concrete question.
```

## First Use In A Project

1. Read `harness/HOW_TO_USE.md` and choose the smallest fitting flow
   family or recipe.
2. Create a request from `docs/delivery/templates/request.md`.
3. Classify the risk lane.
4. For normal or high-risk work, create a delivery brief.
5. Choose agent roles from `harness/agents/`.
6. Run the matching skills from `harness/skills/`.
7. Use the role/skill/rule map in `harness/HOW_TO_USE.md`.
8. Enforce rules from `harness/rules/`.
9. For production implementation, follow `harness/rules/tdd-rules.md`.
10. If the next step is unclear, use the Orchestrator Agent and next-step skill.
11. For proof-of-concept work, write the experiment artifact under
   `docs/delivery/experiments/`.
12. Store experiment code in `experiments/` unless the user, brief, or task
   names another location.
13. Review and verify before completion.
14. Write a trace.

## Suggested First Commit

The first commit in a target project should only add workflow files. Do not mix
workflow adoption with product code changes.
