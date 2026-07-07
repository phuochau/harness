# File Contracts

This workflow uses Markdown files with optional YAML front matter. The front
matter makes state easy for humans and agents to scan.

## Common Fields

```yaml
---
id: REQ-001
status: proposed
lane: normal
owner: intake
created: YYYY-MM-DD
updated: YYYY-MM-DD
depends_on: []
parallelizable: false
---
```

## Status Values

Use these status values unless the receiving project defines a local extension:

- `proposed`: captured but not ready.
- `ready`: ready for the next role.
- `in_progress`: actively being worked.
- `blocked`: cannot proceed without input or external change.
- `review`: ready for review.
- `verify`: ready for verification.
- `done`: completed with proof.
- `rejected`: intentionally not pursued.

Decision records may also use:

- `accepted`: the decision is currently active.
- `superseded`: a newer decision replaced this one.

## Owner Values

Use role owners rather than tool names:

- `orchestrator`
- `intake`
- `delivery-planner`
- `builder`
- `reviewer`
- `verifier`
- `security`
- `qa`
- `historian`
- `human`

## Review Decision Values

Use these values in review artifacts:

- `approved`
- `approved_with_risk`
- `changes_requested`
- `blocked`

## Verification Result Values

Use these values in verification artifacts:

- `passed`
- `failed`
- `blocked`
- `not_applicable`
- `risk_accepted`

## ID Prefixes

- `REQ`: raw request.
- `BRIEF`: delivery brief.
- `TASK`: task.
- `REVIEW`: review note.
- `VERIFY`: verification note.
- `TRACE`: execution trace.
- `DEC`: decision record.

## Recommended Project Layout

When installing into another project, use:

```text
docs/delivery/
  requests/
  briefs/
  tasks/
  reviews/
  verification/
  traces/
  decisions/
  templates/

docs/workflow/
  README.md
  HOW_TO_USE.md
  agents/
  skills/
  rules/
  principles.md
  lifecycle.md
  file-contracts.md
  influence-map.md
  adapters/
```

This repository keeps the workflow package self-contained. A real project can
move the workflow files into `docs/workflow/` and the delivery templates into
`docs/delivery/`.

## Agent-Neutral Rule

Do not make a task depend on a specific agent runtime unless the task is about
that runtime. Write role names and proof commands instead.

Good:

```yaml
owner: verifier
proof_required:
  - npm test
```

Avoid:

```yaml
owner: codex
proof_required:
  - ask Codex to inspect it
```

## Clarification Marker

Use this exact marker when a requirement is unclear:

```text
NEEDS CLARIFICATION: specific question
```

Clarification markers are allowed in requests and research tasks. They should
not remain in ready delivery briefs or implementation tasks unless the task is
explicitly to answer that question.
