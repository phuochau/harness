# Core Workflow Rules

These rules apply to all work.

1. Local files are the source of truth.
2. Agent-specific integrations are adapters only.
3. Do not jump from non-trivial intent directly to implementation.
4. Mark ambiguity with `NEEDS CLARIFICATION: specific question`.
5. Choose the risk lane before editing.
6. Keep tasks bounded to one agent-sized unit of work.
7. Preserve existing user changes.
8. Do not expand scope during implementation.
9. Do not claim completion without proof.
10. Follow test-first implementation for production code unless an exception is
    recorded.
11. Do not let production code import from `experiments/`.
12. Record trace and friction when work changes the project or workflow.
