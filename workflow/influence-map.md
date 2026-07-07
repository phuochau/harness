# Influence Map

This workflow learns from Spec Kit, Superpowers, repository-harness, and common
software delivery team practice.

The point is not to copy any one system. The point is to translate their useful
ideas into a portable, file-based operating model.

## Spec Kit Lessons

Adopt:

- Specifications lead implementation.
- Project principles act as governance.
- Agents should clarify ambiguity instead of guessing.
- Feature work should be expressed as user scenarios with independent tests.
- Plans should connect requirements to technical choices.
- Tasks should be derived from specs and plans.
- Independent tasks should be marked so they can run in parallel.
- Consistency and coverage analysis should happen before implementation.

Adaptation:

- This workflow uses delivery briefs instead of full Spec Kit feature folders
  for normal delivery work.
- A brief can grow into a deeper spec when the work is high-risk or ambiguous.
- The task graph keeps Spec Kit's independent story and task idea but remains
  plain Markdown.

## Superpowers Lessons

Adopt:

- Use the right workflow before acting.
- Brainstorm or clarify before building.
- Write plans for multi-step work.
- Debug systematically: reproduce, identify cause, fix, verify.
- Review before integration.
- Verify before completion.
- Treat missing verification as an honest blocker, not a success.

Adaptation:

- This workflow encodes those behaviors as role contracts and proof gates that
  any agent can follow.
- Agent-specific skills may enforce the rules, but the repo files remain the
  source of truth.

## repository-harness Lessons

Adopt:

- The repository should teach agents how to work on it.
- Classify work by risk lane.
- Use story-sized or task-sized packets for execution.
- Define validation proof before claiming completion.
- Preserve decisions and traces for future agents.
- Record workflow friction so the system improves.

Adaptation:

- This workflow keeps the same operating model but removes the requirement for a
  CLI or SQLite durable layer in version 1.
- State lives in Markdown front matter and reviewable files.

## Product Delivery Lessons

Adopt:

- Work should be transparent, inspectable, and bounded.
- Delivery teams need clear ownership, review, and definition of done.
- QA and security are part of delivery, not afterthoughts.
- Hard decisions often need experiments that prove a candidate solution before
  production implementation.
- Retrospective learning should change future rules.

Adaptation:

- Roles make responsibilities explicit.
- Flows describe standard work patterns: greenfield, brownfield, feature, bug,
  experiment, security audit, and QA.
