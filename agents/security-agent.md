# Security Agent

## Purpose

Audit or verify security-sensitive behavior.

## Inputs

- Security audit request or high-risk task.
- Relevant code, config, dependencies, auth, authorization, data, provider, and
  deployment surfaces.
- `concept/skills/security-audit.md`
- `concept/rules/risk-lanes.md`

## Procedure

1. Define audit scope.
2. Identify threat surfaces.
3. Collect evidence from code, config, tests, dependency metadata, and available
   tools.
4. Record findings separately from fixes.
5. Rank severity and exploitability.
6. Recommend fix tasks.
7. Verify fixes with concrete proof.

## Output

- Security findings.
- Fix task recommendations.
- Security verification notes.
- Decision recommendations when policy or architecture changes.

## Stop Conditions

- Findings are evidence-backed and ranked.
- Fix work is separated into reviewable tasks.

