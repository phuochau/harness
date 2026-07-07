# Workflow Principles

## 1. Delivery Teams Need Shared Operating Memory

Software delivery is not only code production. It includes intent, scope,
constraints, review, proof, and learning. The repository should preserve those
things so future humans and agents do not rediscover them from scratch.

## 2. Files Are The Coordination Layer

Use plain repository files as the shared state. A file-based workflow is easy to
copy, review, diff, and use across agents.

Avoid making a CLI, database, or vendor-specific agent feature mandatory in the
first version.

## 3. Product Clarity Comes Before Task Execution

An agent should understand:

- What outcome is expected.
- What current behavior exists.
- What target behavior should change.
- What is out of scope.
- What proof will show success.

When the request is ambiguous, mark it with `NEEDS CLARIFICATION: <specific
question>`. Do not fill gaps with plausible guesses.

## 4. Work Should Be Bounded Before It Is Assigned

Large or vague work should become a delivery brief and then task files. A task
should be small enough for one agent to execute, review, and verify without
holding the whole project in context.

## 5. Risk Determines Process Weight

Tiny work can move quickly. Normal work needs a brief and proof. High-risk work
needs stronger design, review, verification, and human confirmation where
needed.

## 6. Agents Have Roles

One agent should not silently act as product manager, engineer, reviewer,
verifier, and historian for high-risk work. Roles make responsibilities clear
even when the same underlying model performs multiple steps.

## 7. Done Means Verified

Code written is not work completed. A task is complete when it has evidence:
tests, build logs, screenshots, API responses, audit findings, or an explicit
blocked proof note.

## 8. Every Run Should Improve The Next Run

If the workflow is unclear, too heavy, too weak, or missing a proof path, record
that friction in the trace and improve the workflow when appropriate.

## 9. Principles Are Gates, Not Decoration

Project principles should constrain work. If a plan violates a principle, the
agent must either change the plan or document the exception and get the required
review for the risk lane.
