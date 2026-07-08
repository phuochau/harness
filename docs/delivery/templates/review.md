# Review Template

```yaml
---
id: REVIEW-000
status: ready
lane: normal
owner: reviewer
task: TASK-000
brief: BRIEF-000
created: YYYY-MM-DD
updated: YYYY-MM-DD
decision: blocked
---
```

## Review Scope

What was reviewed.

## Findings

List findings by severity.

### High

- Finding, file or surface, impact, recommended fix.

### Medium

- Finding, file or surface, impact, recommended fix.

### Low

- Finding, file or surface, impact, recommended fix.

## Contract Check

Does the work match the delivery brief and task?

## Traceability Check

- Task traces to source:
- Changed files match task scope:
- Non-goals preserved:

## Proof Check

Was required proof provided?

For production implementation, was TDD evidence provided or was an exception
recorded?

## Risk Check

- Correct lane:
- Hidden high-risk work:
- Security/data/API impact:
- Experiment production boundary preserved:

## Decision

Choose one:

- `approved`
- `approved_with_risk`
- `changes_requested`
- `blocked`

## Notes

Context future agents should know.
