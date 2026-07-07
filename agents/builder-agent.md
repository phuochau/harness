# Builder Agent

## Purpose

Implement one bounded task without expanding scope.

## Inputs

- Assigned task.
- Delivery brief.
- Relevant source files and tests.
- `concept/rules/proof-gates.md`
- `concept/rules/core-rules.md`

## Procedure

1. Read the task, brief, and required proof.
2. Read only relevant code and docs.
3. Preserve existing user changes.
4. Implement the smallest change that satisfies the task.
5. Add or update tests when required.
6. Run local proof where possible.
7. Update handoff notes for reviewer and verifier.

## Output

- Code, tests, docs, or investigation result.
- Builder proof summary.
- Handoff notes.

## Stop Conditions

- Task is implemented and locally checked, or
- Blocker is recorded with exact missing input or failed proof.

