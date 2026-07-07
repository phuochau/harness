# Review Rules

Review findings lead with risk, not style.

Review must check:

- Does the work match the request and brief?
- Do changed files match the task scope?
- Are non-goals preserved?
- Are behavior, API, data, and security contracts preserved?
- Is proof present and relevant?
- For experiments, is the production boundary preserved?
- Is there hidden high-risk work?
- Are follow-up risks explicit?

Review decision values:

- `approved`: no blocking findings.
- `approved_with_risk`: risk is explicit and accepted.
- `changes_requested`: material issue must be fixed.
- `blocked`: review cannot complete.
