# Risk Lane Rules

## Tiny

Use for low-risk docs, copy, narrow visual polish, simple config, or test-only
changes.

Requirements:

- Identify lane.
- Patch directly.
- Run the cheapest relevant proof.

## Normal

Use for bounded feature, bug, refactor, documentation, or workflow changes.

Requirements:

- Request.
- Delivery brief.
- Task file or files.
- Review.
- Verification.
- Trace.

## High-Risk

Use for auth, authorization, data model, migration, security, privacy, payment,
provider, public API, audit logs, data loss, cross-platform behavior, or weak
proof around important behavior.

Requirements:

- Delivery brief.
- Explicit non-goals.
- Design or decision record.
- Task graph.
- Review.
- Strong verification.
- Human confirmation when direction is ambiguous.

## Escalation

If work reveals higher risk, stop and update the lane before continuing.

