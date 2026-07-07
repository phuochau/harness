# Agentic Delivery Workflow

This repository contains a portable, file-based workflow for software delivery teams
using one or more coding agents.

The goal is not to copy Spec Kit, Superpowers, or repository-harness. The goal
is to learn from their strongest ideas and define an agent-neutral delivery
system that can be copied into any software repository.

## Influences

- Spec Kit: clear progression from intent to specification, plan, tasks, and
  implementation.
- Superpowers: disciplined agent behavior, mandatory thinking workflows,
  planning before execution, debugging discipline, and verification before
  completion.
- repository-harness: repo-local operating model, risk lanes, story packets,
  validation proof, decisions, traces, and handoff between agents.
- Product delivery practice: work should be transparent, bounded, reviewed,
  verified, and improved through retrospection.

## Core Principle

The repository is the shared operating surface.

Any agent can participate if it can:

1. Read the local workflow files.
2. Write the expected artifacts.
3. Follow the lifecycle and role contracts.
4. Leave proof before claiming completion.

Agent-specific tools are adapters, not the source of truth.

## Folder Shape

```text
README.md
HOW_TO_USE.md
REVIEW.md
AGENTS.md
INSTALL.md
agents/
  orchestrator-agent.md
  intake-agent.md
  delivery-planner-agent.md
  builder-agent.md
  reviewer-agent.md
  verifier-agent.md
  security-agent.md
  qa-agent.md
  historian-agent.md
skills/
  next-step.md
  intake.md
  principles.md
  brownfield-discovery.md
  delivery-brief.md
  task-planning.md
  artifact-analysis.md
  debugging.md
  security-audit.md
  qa.md
  review.md
  verification.md
  trace.md
rules/
  core-rules.md
  orchestration-rules.md
  risk-lanes.md
  proof-gates.md
  artifact-analysis.md
  review-rules.md
  handoff-rules.md
workflow/
  influence-map.md
  principles.md
  lifecycle.md
  file-contracts.md
templates/
  request.md
  delivery-brief.md
  task.md
  review.md
  verification.md
  trace.md
  decision.md
adapters/
  agent-adapters.md
```

When copying this workflow into another project, the receiving project can keep
the same folder layout or move the workflow files under `docs/workflow/`. The
important part is that `AGENTS.md` points every agent to the workflow
entrypoints.

## Standard Lifecycle

```text
Request
  -> Intake
  -> Delivery brief
  -> Task graph
  -> Artifact analysis
  -> Orchestrator routing when needed
  -> Agent assignment
  -> Build or investigate
  -> Review
  -> Verify
  -> Trace and learn
```

The lifecycle can be short for tiny work, but it must not skip proof. A change
is complete only when the result is verified against the brief or the expected
behavior.

## What This System Learns From Others

This workflow package intentionally adopts a few proven patterns:

- From Spec Kit: keep intent and specifications ahead of implementation, mark
  ambiguity instead of guessing, use project principles as gates, split work by
  independently testable scenarios, and analyze artifacts before execution.
- From Superpowers: require the right workflow before action, make planning and
  debugging explicit, review before integration, and verify before completion.
- From repository-harness: use repo-local instructions, classify risk, require
  validation proof, preserve decisions, and leave traces that help the next
  agent.

See `workflow/influence-map.md` for the full mapping.

## How To Start

Read `HOW_TO_USE.md` to choose a flow family, flow recipe, or
Orchestrator-guided next step. The included recipes cover common cases such as
greenfield, brownfield, feature work, bug fixes, security audit, and QA, but the
workflow is meant to compose into more flows as the project needs them.

Then use the concrete building blocks:

- Ask `agents/orchestrator-agent.md` when the next step is unclear.
- Pick an agent role from `agents/`.
- Run the matching skill from `skills/`.
- Enforce the rules in `rules/`.
- Write artifacts from `templates/`.
