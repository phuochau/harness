# How To Use This Workflow

This guide explains how to choose and compose flows. The reusable building
blocks live in:

- `agents/`: role prompts for agents.
- `skills/`: repeatable workflow skills.
- `rules/`: enforceable operating rules.
- `templates/`: artifact templates.

The examples below are not the only possible flows. They are common operating
patterns built from the same agents, skills, rules, and templates.

When the next step is unclear, use `skills/next-step.md` and ask the
Orchestrator Agent.

## Clean Approach

Use this order for any flow:

1. Identify the work type.
2. Choose the smallest fitting flow.
3. Classify the risk lane.
4. Create only the artifacts the lane needs.
5. Assign a role and skill for the next step.
6. Verify proof before completion.
7. Trace what happened and what should be learned.

Do not create a new named flow when a standard flow plus a small variation is
enough. Do create a new named flow when the same pattern repeats and has its own
entry conditions, roles, proof, or risks.

## Standard Loop

```text
Request
  -> Intake skill
  -> Delivery brief skill when needed
  -> Task planning skill when needed
  -> Artifact analysis when tasks exist
  -> Orchestrator routing when needed
  -> Agent assignment
  -> Build / investigate / review / verify
  -> Trace
```

Tiny work can skip brief and task overhead, but it cannot skip proof.

## When You Do Not Know What Is Next

Use this escape hatch before guessing:

1. Run `skills/next-step.md`.
2. Ask `agents/orchestrator-agent.md`.
3. Read `rules/orchestration-rules.md`.
4. Decide whether to continue, pause, escalate, split work, or ask the human.
5. Record the routing note in the current artifact or trace.

## Flow Families

### Base Flows

Use these to establish or understand the project.

| Flow | Use When | Primary Skills | Main Proof |
| --- | --- | --- | --- |
| Greenfield start | Starting a new product or codebase | intake, principles, delivery-brief, task-planning | first vertical slice runs |
| Brownfield adoption | Entering an existing codebase | brownfield-discovery, intake, next-step | current behavior and validation map |
| Workflow adoption | Installing this operating model | intake, next-step, trace | workflow files are installed and referenced |
| Architecture decision | Choosing stack, boundary, or lasting design | delivery-brief, task-planning, trace | decision record and validation path |

### Delivery Flows

Use these to change product or technical behavior.

| Flow | Use When | Primary Skills | Main Proof |
| --- | --- | --- | --- |
| Add feature | Adding new behavior | intake, delivery-brief, task-planning, verification | acceptance criteria pass |
| Change behavior | Refining accepted behavior | intake, delivery-brief, task-planning, review | old and new behavior are explicit |
| Bug fix | Actual behavior differs from expected behavior | debugging, verification, trace | reproduction or regression proof |
| Refactor | Internal change without intended behavior change | delivery-brief, task-planning, review | behavior-preserving tests pass |
| Spike/research | Answering an implementation uncertainty | intake, next-step, trace | finding, recommendation, or blocker |
| Documentation update | Updating product or technical truth | intake, review, trace | docs match current behavior |

### Quality And Risk Flows

Use these to prove or reduce risk.

| Flow | Use When | Primary Skills | Main Proof |
| --- | --- | --- | --- |
| QA pass | Validating a feature, release, or bug fix | qa, verification, trace | QA result and evidence |
| Security audit | Auditing security-sensitive behavior | security-audit, verification, trace | scoped findings and evidence |
| Performance check | Measuring speed, load, or resource behavior | intake, delivery-brief, verification | benchmark or measurement |
| Accessibility check | Validating accessibility behavior | qa, verification | accessibility evidence |
| Release verification | Checking readiness before release | qa, verification, review | release checklist and proof |

### Operations And Maintenance Flows

Use these to keep the project healthy.

| Flow | Use When | Primary Skills | Main Proof |
| --- | --- | --- | --- |
| Dependency update | Updating packages or tooling | intake, task-planning, verification | build/tests/security checks |
| CI or test repair | Pipeline or test suite is broken | debugging, verification, trace | failing check becomes passing |
| Migration | Data/schema/storage behavior changes | delivery-brief, task-planning, verification | migration proof and rollback notes |
| Incident follow-up | Production issue or severe failure occurred | debugging, trace, delivery-brief | root cause and prevention tasks |
| Cleanup | Removing dead code or stale docs | intake, review, verification | usage check and behavior proof |

### Governance And Learning Flows

Use these to improve the system itself.

| Flow | Use When | Primary Skills | Main Proof |
| --- | --- | --- | --- |
| Retrospective | Work exposed repeated friction | trace, next-step | workflow improvement or accepted risk |
| Rule change | Agent behavior should change | intake, delivery-brief, review | rule update and example |
| Skill change | A repeated procedure needs a better prompt | intake, task-planning, review | skill update and usage note |
| Agent role change | Ownership or handoff is unclear | next-step, review, trace | role contract update |
| Decision review | A past decision may be stale | next-step, verification, trace | accepted or superseded decision |

## Common Flow Recipes

### Greenfield Project

1. Run `skills/intake.md` to capture the product idea as a request.
2. Run `skills/principles.md` to define project principles.
3. Run `skills/delivery-brief.md` for the first vertical slice.
4. Run `skills/task-planning.md` to create the first task graph.
5. Assign Builder, Reviewer, Verifier, and Historian agents.
6. Build the smallest useful vertical slice.
7. Verify baseline proof: build, test, smoke check, and run instructions.
8. Run `skills/trace.md` to record decisions, risks, and next work.

Keep architecture only as detailed as the first slice needs.

### Brownfield Project

1. Run `skills/brownfield-discovery.md`.
2. Map existing entrypoints, docs, scripts, tests, CI, and app surfaces.
3. Identify current validation commands.
4. Record risky areas: missing tests, auth, data, providers, fragile modules.
5. Install workflow files without restructuring the project.
6. Choose one bounded change to prove the workflow.
7. Run review, verification, and trace.

Preserve current behavior first.

### Add New Feature

1. Run `skills/intake.md`.
2. Classify the lane with `rules/risk-lanes.md`.
3. Mark unclear requirements with `NEEDS CLARIFICATION: specific question`.
4. Run `skills/delivery-brief.md`.
5. Run `skills/task-planning.md`.
6. Run artifact analysis from `rules/artifact-analysis.md`.
7. Assign Builder, Reviewer, Verifier, and Historian agents.
8. Build, review, verify, and trace.

Do not expand feature scope during implementation.

### Fix A Bug

1. Run `skills/debugging.md`.
2. Capture expected behavior, actual behavior, and reproduction steps.
3. Reproduce the bug or document why reproduction is blocked.
4. Identify root cause before editing.
5. Add failing proof where practical.
6. Apply the smallest safe fix.
7. Add regression proof.
8. Review, verify, and trace.

Debugging starts with evidence, not guesses.

### Security Audit

1. Run `skills/security-audit.md`.
2. Define scope: auth, authorization, sessions, secrets, dependencies, data,
   APIs, providers, deployment, or audit logs.
3. Treat the lane as high-risk by default.
4. Collect evidence.
5. Record findings separately from fixes.
6. Create one task per meaningful fix.
7. Review and verify each fix.
8. Record decisions for security policy or architecture choices.

Do not claim the system is secure. State what was checked.

### QA

1. Run `skills/qa.md`.
2. Start from the delivery brief and acceptance criteria.
3. Convert criteria into test cases.
4. Run automated proof.
5. Run manual exploratory checks where automation is weak.
6. Record `passed`, `failed`, `blocked`, and `risk_accepted` results.
7. Create follow-up tasks for failures.
8. Write verification and trace notes.

QA starts from the brief, not from the implementation.
