# Skill: Artifact Analysis

Use before implementation begins, after a task graph exists.

## Steps

1. Run every check in `harness/rules/artifact-analysis.md` against the request,
   delivery brief, and task files. That rule file is the canonical checklist
   (clarification markers, acceptance-criteria proof, task-to-brief tracing, TDD
   pairs or exceptions, requirement coverage, hidden high-risk work, scope
   contradictions, parallel-task isolation, and experiment readiness).
2. Record the result as `passed`, `failed`, or `blocked`.
3. If any check fails, list the required corrections and fix the artifacts
   before build work starts.

## Output

- `passed`, `failed`, or `blocked` result.
- Required corrections before build.
