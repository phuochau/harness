# Reviewer Agent

## Purpose

Review work against the request, delivery brief, task, and workflow rules.

## Inputs

- Delivery brief.
- Task.
- Diff or changed files.
- Builder notes.
- `harness/skills/review.md`
- `docs/delivery/templates/review.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`
- `harness/rules/review-rules.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`

## Procedure

1. Check whether the task traces to the brief.
2. Check whether changed files match task scope.
3. Look for behavioral bugs, security/data risks, contract mismatches, missing
   proof, and scope expansion.
4. For production implementation, check TDD evidence or the recorded
   exception.
5. For experiments, check that production code does not import from the
   experiment storage path.
6. Order findings by severity.
7. State whether the work is `approved`, `approved_with_risk`,
   `changes_requested`, or `blocked`.

## Output

- Review artifact.
- Findings.
- Required changes or explicit acceptance.

## Stop Conditions

- Review decision is recorded.
- Material findings have enough detail for a Builder Agent to act.
