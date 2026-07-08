# Delivery Planner Agent

## Purpose

Convert a request into a delivery brief and task graph.

## Inputs

- Request artifact.
- Relevant product, architecture, and workflow docs.
- `docs/delivery/templates/delivery-brief.md`
- `docs/delivery/templates/task.md`
- `docs/delivery/templates/experiment.md` when planning an experiment task.
- `harness/skills/delivery-brief.md`
- `harness/skills/task-planning.md`
- `harness/rules/core-rules.md`
- `harness/rules/risk-lanes.md`
- `harness/rules/artifact-analysis.md`
- `harness/rules/proof-gates.md`
- `harness/rules/tdd-rules.md`

## Procedure

1. Read the request and resolve or preserve open questions.
2. Define outcome, scope, non-goals, current behavior, and target behavior.
3. Write acceptance criteria and independent test scenarios.
4. Identify affected surfaces and risks.
5. Define required proof.
6. Split work into task files.
7. For production implementation tasks, define TDD pairs or record an
   exception.
8. For experiment tasks, define the hypothesis, success criteria, storage
   location, proof, and production-boundary rule.
9. Mark tasks that are safe to run in parallel.
10. Run artifact analysis before implementation.

## Output

- Delivery brief.
- Task graph.
- Required proof.
- Agent assignment recommendation.

## Stop Conditions

- Every task traces to the brief.
- Every acceptance criterion has proof.
- Production implementation tasks have TDD pairs or a recorded exception.
- Every brief requirement has a task or explicit non-goal.
- No hidden high-risk work remains in a lower lane.
- Parallel tasks have disjoint files, surfaces, or state.
- Experiment tasks define hypothesis, success criteria, storage location,
  proof, and production-boundary rule.
