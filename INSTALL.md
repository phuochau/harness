# Copying This Workflow Into Another Project

This workflow package is intentionally file-based. It does not require a CLI,
database, hosted service, or specific coding agent.

## Minimal Install

Create this layout in the target repository:

```text
AGENTS.md
docs/workflow/
docs/delivery/
docs/delivery/experiments/
experiments/
```

Recommended mapping from this repository:

```text
AGENTS.md              -> AGENTS.md
README.md              -> docs/workflow/README.md
HOW_TO_USE.md          -> docs/workflow/HOW_TO_USE.md
agents/*               -> docs/workflow/agents/*
skills/*               -> docs/workflow/skills/*
rules/*                -> docs/workflow/rules/*
workflow/*             -> docs/workflow/*
templates/*            -> docs/delivery/templates/*
adapters/*             -> docs/workflow/adapters/*
experiments/README.md  -> experiments/README.md
```

Then update `AGENTS.md` paths to match the target project layout. If the
workflow files live under `docs/workflow/`, use the sample `AGENTS.md` section
below.

Also keep `REVIEW.md` in this source repository or copy it to
`docs/workflow/REVIEW.md` if the target project wants an audit trail for why the
workflow exists.

## Keep It Agent-Neutral

Do not make Codex, Claude, Cursor, or Copilot the source of truth. Add adapter
files only after the base workflow works as plain repo files.

## Install For Codex

Codex can use the base install directly because it reads `AGENTS.md`.

Minimum Codex install:

```text
AGENTS.md
docs/workflow/
docs/delivery/templates/
docs/delivery/experiments/
experiments/
```

Recommended `AGENTS.md` entry for a target project:

```markdown
# Agent Instructions

This repository uses an agentic delivery workflow. Before changing code, read:

- `docs/workflow/README.md`
- `docs/workflow/HOW_TO_USE.md`
- `docs/workflow/influence-map.md`
- `docs/workflow/file-contracts.md`
- `docs/workflow/rules/core-rules.md`
- `docs/workflow/rules/orchestration-rules.md`
- `docs/workflow/rules/risk-lanes.md`
- `docs/workflow/rules/proof-gates.md`
- `docs/workflow/rules/artifact-analysis.md`
- `docs/workflow/rules/handoff-rules.md`

Choose a role from `docs/workflow/agents/`, run the matching skill from
`docs/workflow/skills/`, and write artifacts from `docs/delivery/templates/`.
If the next step is unclear, use `docs/workflow/skills/next-step.md` and route
through `docs/workflow/agents/orchestrator-agent.md`.
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
under `docs/workflow/agents/`, `docs/workflow/skills/`, and
`docs/workflow/rules/`.

Example Codex adapter body:

```markdown
# Intake

Use this skill when a request first enters the workflow.

Read:

- `AGENTS.md`
- `docs/workflow/HOW_TO_USE.md`
- `docs/workflow/agents/intake-agent.md`
- `docs/workflow/skills/intake.md`
- `docs/workflow/rules/core-rules.md`
- `docs/workflow/rules/risk-lanes.md`

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
docs/workflow/
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
- `docs/workflow/README.md`
- `docs/workflow/HOW_TO_USE.md`
- `docs/workflow/influence-map.md`
- `docs/workflow/file-contracts.md`
- `docs/workflow/rules/core-rules.md`
- `docs/workflow/rules/orchestration-rules.md`
- `docs/workflow/rules/risk-lanes.md`
- `docs/workflow/rules/proof-gates.md`
- `docs/workflow/rules/artifact-analysis.md`
- `docs/workflow/rules/handoff-rules.md`

Use roles from `docs/workflow/agents/`, skills from `docs/workflow/skills/`,
rules from `docs/workflow/rules/`, and templates from
`docs/delivery/templates/`.

If the next step is unclear, use `docs/workflow/skills/next-step.md` and ask
the Orchestrator Agent in `docs/workflow/agents/orchestrator-agent.md`.
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

- `docs/workflow/skills/next-step.md`
- `docs/workflow/agents/orchestrator-agent.md`
- `docs/workflow/rules/orchestration-rules.md`

Return the next role, next skill, required artifact, and whether to continue,
pause, escalate, or ask the human one concrete question.
```

## First Use In A Project

1. Read `docs/workflow/HOW_TO_USE.md` and choose the smallest fitting flow
   family or recipe.
2. Create a request from `docs/delivery/templates/request.md`.
3. Classify the risk lane.
4. For normal or high-risk work, create a delivery brief.
5. Choose agent roles from `docs/workflow/agents/`.
6. Run the matching skills from `docs/workflow/skills/`.
7. Enforce rules from `docs/workflow/rules/`.
8. If the next step is unclear, use the Orchestrator Agent and next-step skill.
9. For proof-of-concept work, write the experiment artifact under
   `docs/delivery/experiments/`.
10. Store experiment code in `experiments/` unless the user, brief, or task
   names another location.
11. Review and verify before completion.
12. Write a trace.

## Suggested First Commit

The first commit in a target project should only add workflow files. Do not mix
workflow adoption with product code changes.
