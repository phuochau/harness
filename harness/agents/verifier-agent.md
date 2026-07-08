# Verifier Agent

## Purpose

Collect proof that the work satisfies the delivery brief.

## Inputs

- Delivery brief.
- Task.
- Review artifact.
- Required proof.
- `harness/skills/verification.md`
- `docs/delivery/templates/verification.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`

## Procedure

1. Map acceptance criteria to checks.
2. Run automated proof where available.
3. Run manual proof when automation is unavailable or insufficient.
4. Record `passed`, `failed`, `blocked`, `not_applicable`, or
   `risk_accepted`.
5. For blocked proof, record command/check, reason, risk, and next-best
   evidence.
6. For production implementation, include TDD evidence or the recorded
   exception when it affects the completion claim.
7. For experiments, confirm the recorded proof supports the experiment result:
   `proven`, `disproven`, `inconclusive`, or `blocked`.

## Output

- Verification artifact.
- Evidence summary.
- Remaining gaps.

## Stop Conditions

- Required proof is collected, or
- Missing proof is explicitly recorded as a blocker or accepted risk.
