# Agent Adapters

The workflow source of truth is the repository files. Agent-specific adapters
should only help an agent follow those files.

## Adapter Rule

Adapters may:

- Point the agent to the workflow files.
- Wrap a role as a command, skill, or prompt.
- Enforce proof gates.
- Enforce the TDD rule.
- Render task summaries.

Adapters must not:

- Define a different lifecycle.
- Hide state outside the repository.
- Make completion claims without writing proof.
- Replace the local workflow files as the source of truth.

## Codex Adapter

Possible files in a target project:

```text
.codex/skills/intake/SKILL.md              wraps docs/workflow/skills/intake.md
.codex/skills/next-step/SKILL.md           wraps docs/workflow/skills/next-step.md
.codex/skills/delivery-planner/SKILL.md    wraps docs/workflow/skills/delivery-brief.md and task-planning.md
.codex/skills/builder/SKILL.md             wraps docs/workflow/agents/builder-agent.md
.codex/skills/reviewer/SKILL.md            wraps docs/workflow/skills/review.md
.codex/skills/verifier/SKILL.md            wraps docs/workflow/skills/verification.md
.codex/skills/historian/SKILL.md           wraps docs/workflow/skills/trace.md
```

Each Codex skill should read `AGENTS.md`, `docs/workflow/HOW_TO_USE.md`, the
relevant files under `docs/workflow/agents/`, `docs/workflow/skills/`, and
`docs/workflow/rules/`, then the assigned artifact path before acting.

## Claude Adapter

Possible files:

```text
CLAUDE.md
.claude/commands/intake.md          wraps docs/workflow/skills/intake.md
.claude/commands/next-step.md       wraps docs/workflow/skills/next-step.md
.claude/commands/plan-delivery.md   wraps docs/workflow/skills/delivery-brief.md and task-planning.md
.claude/commands/review-task.md     wraps docs/workflow/skills/review.md
.claude/commands/verify-task.md     wraps docs/workflow/skills/verification.md
```

`CLAUDE.md` should import or reference `AGENTS.md` and the workflow files.

## Cursor Adapter

Possible files:

```text
.cursor/rules/delivery.mdc      mirrors docs/workflow/HOW_TO_USE.md
.cursor/rules/agents.mdc        mirrors docs/workflow/agents/
.cursor/rules/proof-gates.mdc   mirrors docs/workflow/rules/proof-gates.md
.cursor/rules/tdd.mdc           mirrors docs/workflow/rules/tdd-rules.md
```

Cursor rules should keep the same lifecycle and role names.

## GitHub Copilot Adapter

Possible files:

```text
.github/copilot-instructions.md
```

The instruction file should point Copilot to `AGENTS.md`, the workflow files,
and the current task.

## Generic Agent Adapter

Any agent can use this prompt:

```text
Read AGENTS.md, then read the workflow files it names and the assigned artifact
path. Identify your assigned role. Do only the work allowed by that role.
Before completion, write or update the required proof and trace files.
For production implementation, follow the TDD pairs or record the exception.
```
