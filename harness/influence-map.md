# Influence Map

This workflow learns from Spec Kit, Superpowers, repository-harness, and common
software delivery practice. The point is not to copy any one system, but to
translate their useful ideas into a portable, file-based operating model.

This file is the single source for what the workflow borrows; other docs link
here instead of restating it.

## Spec Kit

Specifications lead implementation.

Adopt:

- Specifications lead implementation, and project principles act as governance.
- Clarify ambiguity instead of guessing.
- Express feature work as user scenarios with independent tests.
- Connect requirements to technical choices, then derive tasks from them.
- Mark independent tasks so they can run in parallel.
- Analyze consistency and coverage before implementation.

Adapt:

- Use delivery briefs instead of full feature folders for normal work; a brief
  can grow into a deeper spec when work is high-risk or ambiguous.
- Keep the independent-task idea, but as plain Markdown in the task graph.

## Superpowers

Disciplined agent behavior.

Adopt:

- Use the right workflow before acting; clarify or brainstorm before building.
- Write plans for multi-step work.
- Use test-first implementation for production behavior changes.
- Debug systematically: reproduce, identify cause, fix, verify.
- Review before integration and verify before completion.
- Treat missing verification as an honest blocker, not a success.

Adapt:

- Encode these behaviors as role contracts and proof gates any agent can follow.
- Agent-specific skills may enforce the rules, but the repo files stay the source
  of truth.

## repository-harness

A repo-local operating model.

Adopt:

- The repository teaches agents how to work on it.
- Classify work by risk lane and execute in task-sized packets.
- Define validation proof before claiming completion.
- Preserve decisions and traces for future agents, and record workflow friction.

Adapt:

- Keep the operating model, but drop the required CLI or SQLite layer in
  version 1. State lives in Markdown front matter and reviewable files.

## Product Delivery Practice

Delivery is a team activity, not just code production.

Adopt:

- Work should be transparent, inspectable, and bounded.
- Ownership, review, and a definition of done should be explicit.
- QA and security are part of delivery, not afterthoughts.
- Hard decisions often need an experiment that proves a candidate solution before
  production implementation.
- Retrospective learning should change future rules.

Adapt:

- Roles make responsibilities explicit.
- Flows describe standard work patterns: greenfield, brownfield, feature, bug,
  experiment, security audit, and QA.
