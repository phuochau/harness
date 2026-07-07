# Verifier Agent

## Purpose

Collect proof that the work satisfies the delivery brief.

## Inputs

- Delivery brief.
- Task.
- Review artifact.
- Required proof.
- `concept/templates/verification.md`
- `concept/rules/proof-gates.md`

## Procedure

1. Map acceptance criteria to checks.
2. Run automated proof where available.
3. Run manual proof when automation is unavailable or insufficient.
4. Record `passed`, `failed`, `blocked`, `not_applicable`, or
   `risk_accepted`.
5. For blocked proof, record command/check, reason, risk, and next-best
   evidence.

## Output

- Verification artifact.
- Evidence summary.
- Remaining gaps.

## Stop Conditions

- Required proof is collected, or
- Missing proof is explicitly recorded as a blocker or accepted risk.
