# Agentic Delivery Workflow

A portable, file-based, agent-neutral workflow for software delivery. Copy it
into any repository and Codex, Claude, Cursor, Copilot, a human, or a CI job can
all follow the same lifecycle, roles, rules, and proof gates from plain
repository files.

The goal is not to copy Spec Kit, Superpowers, or repository-harness, but to
learn from their strongest ideas and define an agent-neutral delivery system.
See `harness/influence-map.md` for what this workflow borrows and how it adapts
each idea.

## Core Principle

The repository is the shared operating surface.

Any agent can participate if it can:

1. Read the local workflow files.
2. Write the expected artifacts.
3. Follow the lifecycle and role contracts.
4. Leave proof before claiming completion.

Agent-specific tools are adapters, not the source of truth.

## How The Pieces Fit Together

The folders have different jobs:

- `harness/HOW_TO_USE.md` is the dispatcher. It helps an agent choose the flow
  family, risk lane, role, skill, and proof path for the current request.
- `harness/lifecycle.md`, `harness/principles.md`, `harness/file-contracts.md`,
  and `harness/influence-map.md` define the shared model: how the system works,
  why it exists, and the file shapes it uses.
- `harness/agents/` defines role contracts. A role says who owns the next
  decision, what inputs it must read, and when it must stop.
- `harness/skills/` defines repeatable procedures. A skill says how a role
  performs a specific workflow action.
- `harness/rules/` defines cross-cutting gates and constraints. Rules do not
  replace workflows; they decide whether a flow step is ready, safe, reviewed,
  or complete.
- `docs/delivery/templates/` defines the artifacts agents write so work can move
  between roles.
- `harness/adapters/` explains optional runtime wrappers for Codex, Claude,
  Cursor, or Copilot. Adapters point back to the repository files; they must not
  become a second workflow.

`experiments/` is only for bounded proof-of-concept code, never production
dependencies. The source repository also keeps a REVIEW.md changelog of
alignment reviews; it is not copied into installed projects.

## Folder Shape

This is the layout the installers create in a target project (the source
repository is the same, plus top-level `scripts/` and `tests/` used to build and
verify installs):

```text
AGENTS.md                   # entrypoint every agent reads first
CLAUDE.md                   # Claude entrypoint (Claude installs only)
harness/
  README.md
  HOW_TO_USE.md
  influence-map.md
  principles.md
  lifecycle.md
  file-contracts.md
  agents/                   # role contracts (one per role)
  skills/                   # repeatable procedures
  rules/                    # cross-cutting gates
  adapters/
    agent-adapters.md
docs/delivery/
  templates/                # request, brief, task, review, verification,
                            # trace, decision, experiment file shapes
  requests/ briefs/ tasks/ experiments/ reviews/ verification/ traces/ decisions/
experiments/
  README.md
.claude/commands/           # Claude command adapters (optional)
.agents/skills/             # Codex skill adapters (optional)
```

All package references use this installed layout: workflow files under
`harness/`, artifact templates under `docs/delivery/templates/`, and filled-in
artifacts under `docs/delivery/<type>/`. `AGENTS.md` points every agent to these
entrypoints. For the exact file fields, status values, and ID prefixes, see
`harness/file-contracts.md`.

## Lifecycle

The standard path is:

```text
Request -> Intake -> Delivery brief -> Task graph -> Artifact analysis
  -> Orchestrator routing when needed -> Agent assignment
  -> Build under TDD, investigate, or experiment -> Review -> Verify
  -> Trace and learn
```

It can be short for tiny work, but it must not skip proof: a change is complete
only when the result is verified against the brief or the expected behavior.

See `harness/lifecycle.md` for the stage-by-stage description and flow diagrams.

## How To Start

Read `harness/HOW_TO_USE.md` to choose a flow family, flow recipe, or
Orchestrator-guided next step. The included recipes cover common cases such as
greenfield, brownfield, feature work, bug fixes, experiments, security audit,
and QA, and the workflow composes into more flows as the project needs them.

Then use the concrete building blocks:

- Ask `harness/agents/orchestrator-agent.md` when the next step is unclear.
- Pick an agent role from `harness/agents/`.
- Run the matching skill from `harness/skills/`.
- Enforce the role's required rules from `harness/rules/`.
- Write artifacts from `docs/delivery/templates/`.
