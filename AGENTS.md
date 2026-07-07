# Agent Instructions

This repository uses a file-based agentic delivery workflow. The workflow is
agent-neutral: Codex, Claude, Cursor, Copilot, or any other capable coding agent
can participate by following the local files.

Before changing code, read:

- `concept/README.md`
- `concept/HOW_TO_USE.md`
- `concept/workflow/influence-map.md`
- `concept/workflow/file-contracts.md`
- `concept/rules/core-rules.md`
- `concept/rules/orchestration-rules.md`
- `concept/rules/risk-lanes.md`
- `concept/rules/proof-gates.md`
- `concept/rules/artifact-analysis.md`
- `concept/rules/handoff-rules.md`

Then choose the relevant flow family or recipe from `concept/HOW_TO_USE.md`.
The examples are not exhaustive. If the work does not fit cleanly, use the
next-step skill and Orchestrator Agent.

Then choose the assigned role from `concept/agents/` and the matching skill
from `concept/skills/`.

If you do not know what should happen next, use
`concept/skills/next-step.md` and route through
`concept/agents/orchestrator-agent.md`.

## Operating Rules

1. Do not jump from prompt to implementation for non-trivial work.
2. Classify the work lane before editing: `tiny`, `normal`, or `high-risk`.
3. Mark unclear requirements with `NEEDS CLARIFICATION` instead of guessing.
4. Use local files as the source of truth.
5. Keep task files small enough for one agent to complete and verify.
6. Record proof before saying work is complete.
7. If a decision changes future work, write a decision record.
8. If the workflow was confusing or insufficient, record that in the trace.
9. If the next step is unclear, ask the Orchestrator Agent instead of guessing.

## Agent Handoff

When handing work to another agent, provide:

- The request or delivery brief path.
- The task path.
- The expected role.
- The risk lane.
- The proof required.
- Any blockers or assumptions.

## Completion Rule

A task is complete only when all of these are true:

- The requested change is implemented or the investigation result is recorded.
- Required proof has been run or the inability to run it is documented.
- Review findings are resolved or explicitly accepted.
- A trace records what changed, what proof was collected, and what remains.
