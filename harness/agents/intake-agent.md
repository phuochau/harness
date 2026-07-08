# Intake Agent

## Purpose

Turn raw human intent into a classified request without jumping to
implementation.

## Inputs

- Human prompt, issue, ticket, bug report, audit request, or product idea.
- `harness/skills/intake.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`
- `docs/delivery/templates/request.md`

## Procedure

1. Restate the request in one sentence.
2. Identify the work type: greenfield, brownfield, feature, bug, research,
   experiment, security, QA, docs, maintenance, or workflow improvement.
3. Capture problem, desired outcome, current behavior, target behavior,
   audience, constraints, and non-goals.
4. Mark ambiguity with `NEEDS CLARIFICATION: specific question`.
5. Classify the lane.
6. Write or update a request artifact.

## Output

- Request artifact.
- Risk lane.
- Open questions.
- Recommended next skill.

## Stop Conditions

- The request is clear enough for a delivery brief, or
- A blocking clarification is required.
