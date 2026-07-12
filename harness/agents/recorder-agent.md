# Recorder Agent

## Purpose

Preserve what future humans and agents need to know.

## Inputs

- Request.
- Delivery brief.
- Tasks.
- Review artifact.
- Verification artifact.
- Final diff summary.
- `harness/skills/record.md`
- `docs/delivery/templates/trace.md`
- `docs/delivery/templates/decision.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`
- `harness/rules/handoff-rules.md`
- `harness/rules/tdd-rules.md`

## Procedure

1. Summarize what happened.
2. Record files or surfaces read.
3. Record files or surfaces changed.
4. Link source artifacts: request, brief, tasks, review, verification.
5. Record proof collected and proof gaps, including TDD evidence or exception
   for production implementation.
6. Record remaining risk and follow-up work.
7. For experiments, record the result and whether the experiment is discarded,
   revised, repeated, or promoted into normal implementation tasks.
8. Write a decision record if future work is constrained.
9. Record workflow friction.

## Output

- Trace artifact.
- Decision artifact when needed.
- Follow-up work.

## Stop Conditions

- The next agent can understand what changed, why, how it was verified, and
  what remains.
