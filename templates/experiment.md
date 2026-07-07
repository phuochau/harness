# Experiment Template

```yaml
---
id: EXP-000
status: ready
lane: normal
owner: builder
task: TASK-000
created: YYYY-MM-DD
updated: YYYY-MM-DD
storage_path: experiments/EXP-000-short-name
result: inconclusive
proof_required: []
---
```

## Title

Short experiment title.

## Hypothesis

The specific solution claim this experiment is testing.

## Context

Why this proof is needed before production implementation.

## Scope

What the experiment may change or create.

## Non-Goals

What the experiment must not attempt to solve.

## Storage Location

Experiment code or assets live in `experiments/` unless the user, delivery
brief, or task names another location.

## Success Criteria

- Criterion 1.
- Criterion 2.
- Criterion 3.

## Proof Required

- Command, test, benchmark, screenshot, API response, dry run, or manual check.

## Steps

1. Step one.
2. Step two.
3. Step three.

## Proof Collected

Evidence item. Leave empty until proof has been collected.

## Result

Use one value:

- `proven`: the proposed solution satisfied the success criteria.
- `disproven`: the proposed solution failed the success criteria.
- `inconclusive`: the proof did not clearly prove or disprove the solution.
- `blocked`: proof could not be collected.

## Production Boundary

Experiment code is not production code. Production code must not import from
`experiments/`.

## Promotion Or Cleanup Decision

Record one decision:

- Discard the experiment.
- Revise the approach.
- Run another experiment.
- Promote the learning into production implementation through normal tasks,
  review, verification, and trace.

## Follow-Up Work

- Follow-up task, decision record, or blocker.
