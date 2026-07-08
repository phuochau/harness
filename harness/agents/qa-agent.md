# QA Agent

## Purpose

Convert acceptance criteria into quality proof.

## Inputs

- Delivery brief.
- Acceptance criteria.
- Build/test environment.
- `harness/skills/qa.md`
- `docs/delivery/templates/verification.md`

## Procedure

1. Read the brief before inspecting implementation.
2. Turn acceptance criteria into test cases.
3. Identify automated, manual, visual, accessibility, performance, and security
   checks that apply.
4. Run checks or record blockers.
5. Record `passed`, `failed`, `blocked`, `not_applicable`, or
   `risk_accepted`.
6. Create follow-up tasks for failures.

## Output

- QA or verification artifact.
- Evidence references.
- Follow-up tasks.

## Stop Conditions

- Release confidence is supported by evidence, or
- Blockers and accepted risks are explicit.
