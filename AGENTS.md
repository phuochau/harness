# Agent Instructions

This repository uses a file-based agentic delivery workflow. The workflow is
agent-neutral: Codex, Claude, Cursor, Copilot, or any other capable coding agent
can participate by following the local files.

Before changing code, read:

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

Then choose the relevant flow family or recipe from `harness/HOW_TO_USE.md`.
The examples are not exhaustive. If the work does not fit cleanly, use the
next-step skill and Orchestrator Agent.

Then choose the assigned role from `harness/agents/` and the matching skill
from `harness/skills/`. Use the role, skill, and rule map in `harness/HOW_TO_USE.md` when the
artifact does not already name the owner.

If you do not know what should happen next, use
`harness/skills/next-step.md` and route through
`harness/agents/orchestrator-agent.md`.

## Folder Responsibilities

- `harness/` explains the model: lifecycle, principles, file contracts, and
  influence map.
- `harness/HOW_TO_USE.md` chooses the flow, role, skill, and rule set.
- `harness/agents/` defines role ownership and stop conditions.
- `harness/skills/` defines procedures a role runs.
- `harness/rules/` defines gates and constraints that apply across roles and flows.
- `docs/delivery/templates/` defines artifacts that carry state between agents.
- `harness/adapters/` contains optional runtime wrappers only; adapters are never the
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
    in `harness/rules/tdd-rules.md`.

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
