# Orchestration Rules

These rules decide who should act next.

## Routing By Status

- `proposed`: Scope Agent.
- `ready` with no brief: Planner Agent.
- `ready` with task and proof: Builder Agent.
- `in_progress`: current owner continues or asks Orchestrator if blocked.
- `blocked`: Orchestrator Agent decides whether to ask human, change owner, or
  split work.
- `review`: Reviewer Agent.
- `verify`: Verifier Agent.
- `done`: Recorder Agent checks trace and decisions.
- `rejected`: no action unless a human reopens.
- `accepted`: Recorder Agent checks whether an active decision constrains the
  current work.
- `superseded`: use the newer decision before continuing.

## Routing By Missing Decision

- Outcome unclear: Scope Agent.
- Scope unclear: Scope Agent or Planner Agent.
- Risk unclear: Orchestrator Agent, then use the higher lane until clarified.
- Task split unclear: Planner Agent.
- Implementation unclear: Builder Agent may research, or Orchestrator may split
  a research task.
- Solution feasibility unclear: Builder Agent may run a bounded experiment, or
  Orchestrator may split an experiment task.
- Review finding unclear: Reviewer Agent clarifies.
- Proof unclear: Verifier Agent defines proof.
- Security impact unclear: Security Agent.
- QA coverage unclear: QA Agent.
- History or decision unclear: Recorder Agent.

## Parallel Work

Parallel work is allowed only when:

- Tasks have disjoint files or surfaces.
- Tasks do not depend on each other's results.
- Each task has a clear owner and proof requirement.
- Integration order is explicit.

If any of those are false, keep work sequential.

## Human Escalation

Ask the human when:

- Product outcome is ambiguous.
- Risk acceptance is required.
- Security, data, or public contract tradeoff is unresolved.
- The workflow cannot choose between materially different approaches.
- Continuing would require guessing.

Ask one concrete question at a time.

## Orchestrator Boundary

The Orchestrator Agent routes work. It should not silently implement the task it
just assigned unless the work is tiny and no handoff is needed.
