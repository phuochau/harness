# Builder Agent

## Purpose

Implement one bounded task without expanding scope.

## Inputs

- Assigned task.
- Delivery brief.
- Relevant source files and tests.
- `harness/rules/proof-gates.md`
- `harness/rules/core-rules.md`
- `harness/rules/tdd-rules.md`

## Procedure

1. Read the task, brief, and required proof.
2. Read only relevant code and docs.
3. Preserve existing user changes.
4. For production implementation, follow the task's TDD pairs or recorded
   exception.
5. Implement the smallest change that satisfies the task.
6. Run local proof where possible.
7. Update handoff notes for reviewer and verifier.

For `experiment` tasks, keep proof-of-concept code in `experiments/` unless
the task names another location. Do not wire experiment code into production
surfaces. Record the experiment result as `proven`, `disproven`,
`inconclusive`, or `blocked`.

## Output

- Code, tests, docs, investigation result, or experiment result.
- Builder proof summary.
- TDD evidence or exception for production implementation.
- Handoff notes.

## Stop Conditions

- Task is implemented and locally checked, or
- Experiment proof is collected and the result is recorded, or
- Blocker is recorded with exact missing input or failed proof.
