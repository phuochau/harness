# Task Template

```yaml
---
id: TASK-000
status: ready
lane: normal
type: build
owner: builder
brief: BRIEF-000
created: YYYY-MM-DD
updated: YYYY-MM-DD
depends_on: []
parallelizable: false
proof_required: []
---
```

## Goal

What this task should accomplish.

## Trace To Source

Request, brief section, acceptance criterion, finding, experiment result, or QA
case that justifies this task.

## Inputs

- Request or brief path.
- Relevant docs.
- Relevant files or surfaces.

## Expected Changes

What the assigned agent may change.

For `experiment` tasks, include the experiment artifact path and storage path.
Experiment code defaults to `experiments/` unless another location is named.

## Out Of Scope

What the assigned agent must not change.

## Steps

1. Step one.
2. Step two.
3. Step three.

## Proof Required

- Proof item.

For `experiment` tasks, proof must be sufficient to mark the result as
`proven`, `disproven`, `inconclusive`, or `blocked`.

## Parallel Safety

Can this task run at the same time as other tasks? If yes, list the disjoint
files or surfaces it owns.

## Handoff Notes

Notes for reviewer, verifier, or next task.

## Blockers

Known blockers or unresolved questions.
