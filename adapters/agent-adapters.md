# Agent Adapters

The workflow source of truth is the repository files. Agent-specific adapters
should only help an agent follow those files.

An adapter is optional glue for one runtime. It can turn a generic role or skill
into a Codex skill, Claude command, Cursor rule, Copilot instruction, or another
agent-specific prompt. The adapter may improve ergonomics, but the lifecycle,
roles, rules, artifacts, and completion criteria still come from the local
workflow files.

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

When an adapter and a repository workflow file disagree, follow the repository
workflow file and record the adapter mismatch in the trace or review note.

## Codex Adapter

Possible files in a target project:

```text
.codex/skills/intake/SKILL.md              wraps harness/skills/intake.md
.codex/skills/next-step/SKILL.md           wraps harness/skills/next-step.md
.codex/skills/delivery-planner/SKILL.md    wraps harness/skills/delivery-brief.md and task-planning.md
.codex/skills/builder/SKILL.md             wraps harness/agents/builder-agent.md
.codex/skills/reviewer/SKILL.md            wraps harness/skills/review.md
.codex/skills/verifier/SKILL.md            wraps harness/skills/verification.md
.codex/skills/historian/SKILL.md           wraps harness/skills/trace.md
```

Each Codex skill should read `AGENTS.md`, `harness/HOW_TO_USE.md`, the
relevant files under `harness/agents/`, `harness/skills/`, and
`harness/rules/`, then the assigned artifact path before acting.

## Claude Adapter

Possible files:

```text
CLAUDE.md
.claude/commands/intake.md          wraps harness/skills/intake.md
.claude/commands/next-step.md       wraps harness/skills/next-step.md
.claude/commands/plan-delivery.md   wraps harness/skills/delivery-brief.md and task-planning.md
.claude/commands/review-task.md     wraps harness/skills/review.md
.claude/commands/verify-task.md     wraps harness/skills/verification.md
```

`CLAUDE.md` should import or reference `AGENTS.md` and the workflow files.

## Cursor Adapter

Possible files:

```text
.cursor/rules/delivery.mdc      mirrors harness/HOW_TO_USE.md
.cursor/rules/agents.mdc        mirrors harness/agents/
.cursor/rules/proof-gates.mdc   mirrors harness/rules/proof-gates.md
.cursor/rules/tdd.mdc           mirrors harness/rules/tdd-rules.md
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
