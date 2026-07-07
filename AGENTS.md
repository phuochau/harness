# Agent Instructions

This repository uses a file-based agentic delivery workflow. The workflow is
agent-neutral: Codex, Claude, Cursor, Copilot, or any other capable coding agent
can participate by following the local files.

Before changing code, read:

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

Then choose the relevant flow family or recipe from `HOW_TO_USE.md`.
The examples are not exhaustive. If the work does not fit cleanly, use the
next-step skill and Orchestrator Agent.

Then choose the assigned role from `agents/` and the matching skill
from `skills/`. Use the role, skill, and rule map in `HOW_TO_USE.md` when the
artifact does not already name the owner.

If you do not know what should happen next, use
`skills/next-step.md` and route through
`agents/orchestrator-agent.md`.

## Folder Responsibilities

- `workflow/` explains the model: lifecycle, principles, file contracts, and
  influence map.
- `HOW_TO_USE.md` chooses the flow, role, skill, and rule set.
- `agents/` defines role ownership and stop conditions.
- `skills/` defines procedures a role runs.
- `rules/` defines gates and constraints that apply across roles and flows.
- `templates/` defines artifacts that carry state between agents.
- `adapters/` contains optional runtime wrappers only; adapters are never the
  source of truth.

## Operating Rules

1. Do not jump from prompt to implementation for non-trivial work.
2. Classify the work lane before editing: `tiny`, `normal`, or `high-risk`.
3. Mark unclear requirements with `NEEDS CLARIFICATION: specific question`
   instead of guessing.
4. Use local files as the source of truth.
5. Keep task files small enough for one agent to complete and verify.
6. Record proof before saying work is complete.
7. Follow test-first implementation for production code unless an exception is
   recorded.
8. If a decision changes future work, write a decision record.
9. If the workflow was confusing or insufficient, record that in the trace.
10. If the next step is unclear, ask the Orchestrator Agent instead of guessing.
11. For docs-only, research, experiment, generated, pure markup, or non-runtime
    configuration work, record the TDD exception and replacement proof described
    in `rules/tdd-rules.md`.

## Agent Handoff

When handing work to another agent, provide:

- The request or delivery brief path.
- The task path.
- The expected role.
- The risk lane.
- The proof required.
- The TDD pairs or recorded TDD exception for production implementation.
- Any blockers or assumptions.
- The experiment artifact and storage path when the task type is `experiment`.

## Completion Rule

A task is complete only when all of these are true:

- The requested change is implemented, or the investigation or experiment
  result is recorded.
- Required proof has been run or the inability to run it is documented.
- Review findings are resolved or explicitly accepted.
- A trace records what changed, what proof was collected, and what remains.
