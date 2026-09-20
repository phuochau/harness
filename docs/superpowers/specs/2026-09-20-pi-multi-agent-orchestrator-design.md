# Pi Multi-Agent Orchestrator Harness Design

**Date:** 2026-09-20

**Status:** Approved conversational design, pending written-spec review

## 1. Purpose

Build a reusable, installable harness for running a large feature or project
end to end over multiple hours or days. The harness uses Pi as the sole global
orchestrator, Spec Kit as the planning system, Herdr as the local agent runtime,
Codex/Devin/Claude as coding workers, and Superpowers as the engineering
discipline inside workers.

The default installed workflow is:

```text
Human
  -> Pi using a local ChatGPT subscription profile
  -> Spec Kit produces spec.md, plan.md, tasks.md, task-graph.json
  -> Pi schedules the task graph
  -> Devin implements ready tasks
  -> Codex reviews task results
  -> Pi verifies and integrates commits
  -> Pi runs final verification and creates the final pull request
```

This is only the default. A project may freely replace the workflow DAG,
stages, agents, gates, retry policy, and commands without changing the harness
engine.

## 2. Goals

- Install into a new repository and be usable immediately.
- Provision missing Pi packages, Spec Kit integration, Superpowers, Herdr,
  Herdr agent integrations, worker CLIs, and required local tools after one
  explicit approval.
- Run independent tasks concurrently without sharing working directories.
- Persist workflow state outside LLM context so work can recover after Pi,
  Herdr, a worker, or the machine restarts.
- Support Codex CLI, Devin CLI, and Claude Code as first-class workers.
- Make workflow structure project-owned data rather than hard-coded control
  flow.
- Prevent workers from declaring their own tasks complete.
- Require review, tests, evidence, integration, and final verification before
  completion claims.
- Keep Pi as the only component that makes orchestration decisions.

## 3. Non-goals

The first release does not include:

- Remote access, Tailscale, phone control, or Pi Web remote operation.
- Herdr multi-machine execution.
- A direct process runtime that bypasses Herdr.
- Devin API transport; Devin CLI is the first transport.
- A web dashboard.
- A workflow marketplace.
- LLM-invented routing policies.
- Automatic mutation of product requirements or architecture.
- Automatic generation of remediation tasks that alter Spec Kit planning.
- Usage telemetry or analytics.

## 4. Responsibility Boundaries

| Layer | Responsibility |
|---|---|
| Human | Product decisions, approvals, and resolution of planning conflicts |
| Spec Kit | Requirements, architecture, acceptance criteria, plan, and task definitions |
| Pi | Workflow orchestration, scheduling, routing, retries, state transitions, integration, and final verification |
| Harness core | Deterministic workflow compiler, DAG engine, state machine, policies, and contracts invoked by Pi |
| Herdr | Local worktrees, terminal sessions, agent lifecycle observation, prompts, waits, and session restoration |
| Codex/Devin/Claude | Implementation or review work assigned by Pi |
| Superpowers | TDD, debugging, verification, and review discipline inside a worker |
| Tests and CI | Executable correctness evidence |

Herdr is an execution plane, not a second orchestrator. It never decides which
task is ready, which agent should receive a task, whether to retry, or whether a
task is complete.

## 5. System Architecture

```text
Pi extension
  |- commands, approvals, and semantic status
  |- orchestration loop
  `- deterministic harness core
       |- workflow compiler
       |- Spec Kit task-graph validator
       |- DAG scheduler
       |- task/run state machines
       |- routing and retry policies
       |- security policy evaluator
       |- verification and integration gates
       `- AgentRuntime interface
            `- HerdrRuntime
                 |- CodexCliAdapter
                 |- DevinCliAdapter
                 `- ClaudeCliAdapter
```

The implementation is one publishable Pi package containing the extension,
CLI, core, schemas, Herdr runtime, worker adapters, and default workflows. Its
source remains modular so parts can be split into packages later without
changing public contracts.

The implementation language is TypeScript on Node.js. The initial core uses
JSON Schema/TypeBox for contracts, YAML for project-authored workflows, JSONL
for append-only events, JSON for snapshots, the Herdr CLI for simple commands,
the Herdr socket API for subscriptions, and Git CLI commands for verification
and integration.

## 6. Project Layout

Committed project configuration:

```text
.pi/
  settings.json

.harness/
  workflow.yaml
  environment.yaml
  policy.yaml
  harness.lock
  bootstrap.mjs
  workflows/
    examples/
      spec-kit-codex.yaml
      spec-kit-devin.yaml
      mixed-workers.yaml
```

Local, gitignored runtime data:

```text
.harness/
  runs/
    F023/
      resolved-workflow.json
      state.json
      events.jsonl
      assignments/
      workers/
      evidence/
      logs/
  receipts/
    machine-identity.json
```

`.pi/` remains Pi's native namespace. `.harness/` owns harness configuration
and state. The design does not use a generic `.ai/` directory.

## 7. Workflow DSL

A workflow is freely editable project-owned YAML. Profiles are examples, not
restrictions. The engine does not hard-code stage names such as `plan`,
`implement`, or `review`.

```yaml
schema: harness/v1
name: spec-kit-devin

stages:
  - id: tasks
    uses: spec-kit.tasks
    runner: pi
    model_profile: chatgpt-planning
    produces:
      tasks: feature/tasks.md
      graph: feature/task-graph.json

  - id: implement
    uses: worker.execute
    runner: devin
    needs: [tasks]
    foreach: tasks.ready
    isolation: worktree
    profile: disciplined-engineer

  - id: review
    uses: worker.review
    runner: codex
    needs: [implement]
    foreach: tasks.completed

  - id: verify
    uses: command.run
    needs: [review]
    with:
      command: npm test

  - id: integrate
    uses: git.integrate
    needs: [verify]
```

Common stage fields are `id`, `uses`, `runner`, `needs`, `if`, `foreach`,
`with`, `policies`, `produces`, `retry`, `timeout`, and `on_failure`.

`uses` names a registered action or an explicit shell action. `runner` chooses
where that action runs. Before a run starts, the compiler validates the schema,
resolves references, checks cycles and capability requirements, intersects
permissions, and freezes the result as `resolved-workflow.json`. Editing
`workflow.yaml` never mutates an active run.

The resolved workflow records its content hash. Continuing a run with a
different workflow requires an explicit new revision or a new run.

## 8. Spec Kit Contract and Task Graph

Spec Kit remains the source of product intent. Workers may read `spec.md`,
`plan.md`, and `tasks.md`, but may not change requirements, architecture, task
definitions, or acceptance criteria.

The standard Spec Kit task format includes task IDs, phases, parallel markers,
story labels, descriptions, and file paths, but not an explicit dependency
list for every task. The harness therefore installs a Spec Kit integration that
generates a machine-readable projection during the same task-planning step:

```text
specs/feature-name/
  spec.md
  plan.md
  tasks.md
  task-graph.json
```

`task-graph.json` uses `harness/task-graph/v1` and contains:

- Every task ID.
- Explicit `dependsOn` task IDs.
- Parallel eligibility.
- Declared file scope.
- Acceptance-criteria references.
- A semantic hash of `tasks.md` definitions.

The semantic hash normalizes checkbox state before hashing. Therefore Pi may
change `- [ ]` to `- [x]` after a task reaches `DONE` without invalidating the
graph, while any change to an ID, description, phase, label, or file path does
invalidate it.

Pi refuses execution when the graph has cycles, unknown task IDs, missing
dependencies, invalid acceptance references, a stale semantic hash, or file
ownership conflicts between tasks that the graph would otherwise permit to run
in parallel. File overlap is valid when the graph orders the tasks. Pi never
asks an LLM to guess missing dependencies during execution.

## 9. Persistent State

Each run stores:

- `resolved-workflow.json`: immutable workflow and validated task graph.
- `events.jsonl`: append-only authoritative event history.
- `state.json`: atomically replaced materialized snapshot derived from events.
- Assignment bundles, attempt records, worker/session identifiers, logs, and
  evidence.

Only one Pi orchestration session may own the run lock. Events have monotonic
revisions and idempotency keys. Replaying the same event history must always
produce the same state.

After restart, Pi acquires the lock, replays events, validates the snapshot,
queries Herdr for workspaces and agents, inspects Git state and worker results,
then deterministically reattaches, resumes, retries, blocks, or verifies each
attempt.

## 10. Task Lifecycle

```text
PENDING
  -> READY
  -> RUNNING
  -> VERIFYING
  -> DONE

Error paths:
  RUNNING or VERIFYING -> RETRY -> READY
  any active state -> BLOCKED
  retry exhaustion or nonrecoverable error -> FAILED
```

Rules:

- `PENDING` becomes `READY` only after every dependency is `DONE`.
- A task has at most one active lease and one active worker attempt.
- Worker completion changes the task to `VERIFYING`, never directly to `DONE`.
- `BLOCKED` does not consume retry budget by itself.
- Every retry creates an immutable attempt record.
- Rerouting occurs only between attempts.
- Pi updates the `tasks.md` checkbox only after `DONE`.

Herdr lifecycle is treated as observation:

| Herdr state | Harness interpretation |
|---|---|
| `working` | Attempt appears active |
| `blocked` | Inspect the prompt/result, then create a blocker event if confirmed |
| `idle` or `done` | Look for a structured worker result; do not infer success |
| `unknown` | Run health checks, then reconcile or time out |

## 11. Git and Worktree Model

At run creation, Pi freezes the base commit and creates an integration branch:

```text
main at frozen commit
  `- harness/run-F023
       |- harness/F023-T001
       |- harness/F023-T002
       `- harness/F023-T004
```

Herdr creates or opens each task worktree. A task branch begins from an
integration commit containing all completed dependency commits. Independent
tasks may run concurrently from their appropriate integration bases.

After worker completion, Pi validates the result and commits, performs review
and task verification, serializes integration into the run branch, and runs
post-integration checks. A conflict leaves the task in `VERIFYING` and creates
a remediation attempt or blocker. `DONE` means the commit is integrated and
post-integration checks passed.

After all tasks are done, Pi runs the full verification suite, reviews the
final diff, pushes the integration branch, and creates the final pull request.

## 12. Herdr Runtime

Herdr is required in the first release and is local-only. The harness uses:

- `worktree.create`, `worktree.open`, and `worktree.remove`.
- `agent.start`, `agent.prompt`, `agent.wait`, `agent.read`, and cancellation
  controls.
- Event subscriptions for lifecycle changes.
- Native session identifiers for restart reconciliation.

Bootstrap installs and verifies the Herdr integrations for Pi, Codex, Devin,
and Claude.

Normal detach leaves the Herdr server and worker processes alive. A cold Herdr
or machine restart may lose arbitrary processes, so Herdr session restoration
does not replace harness state. Pi always reconciles persistent state and
retries work that cannot be resumed safely.

The first release does not implement a Herdr workflow plugin. Pi calls the
Herdr CLI/socket API directly so Herdr cannot become an alternate workflow
authority.

## 13. Worker Adapters and Assignment Contract

All worker adapters implement:

```text
probe
prepare
launch
observe
resume
cancel
collect
```

Each immutable assignment bundle contains task identity, acceptance
references, planning-artifact paths, frozen base information, allowed file
scope, required Superpowers disciplines, verification commands, protected
paths, and the result schema.

Workers write `.harness-output/result.json` inside their task worktree. The
directory is gitignored and may not be included in a task commit. Pi copies and
hashes accepted results and evidence into the run directory.

The normalized result uses `harness/worker-result/v1` and includes:

- Task ID and attempt number.
- Outcome: `completed`, `blocked`, or `failed`.
- Summary and commit SHAs.
- Test commands, exit codes, and evidence paths.
- Superpowers disciplines and evidence.
- A typed blocker with reason, evidence, and suggested change when blocked.
- A resumable native session reference when available.

Malformed or missing results fail the attempt. Pi never parses a prose terminal
message to infer successful completion.

## 14. Superpowers

Superpowers is a worker discipline, not the global orchestrator. The default
worker profile enables:

- Test-driven development for implementation.
- Systematic debugging for unexpected behavior.
- Verification before completion.
- Code review discipline for review stages.

The default completion contract requires tests, commits, evidence, and
independent verification. A project may explicitly replace or disable the
discipline in its workflow, subject to the effective machine security policy.

Adapters report support as `native`, `injected`, or `unsupported`. A stage that
requires `native` support fails preflight when its selected worker cannot
provide it. The harness never silently drops a required discipline.

## 15. Routing, Retries, and Blockers

Stages may explicitly name a worker or select by capability and ordered
preference. The general auto-selection preference is Codex, then Devin, then
Claude. The shipped default workflow overrides this by assigning implementation
to Devin, review to Codex, and using Codex then Claude as implementation
fallbacks.

Routing is deterministic and considers only declared order, capabilities,
availability/authentication, concurrency limits, and policy. Every routing
decision is recorded as an event.

Logical model profiles are committed, while provider credentials and the
mapping from `chatgpt-planning` to the local ChatGPT subscription remain in
machine-local Pi configuration.

Failure categories and default responses are:

| Category | Response |
|---|---|
| Transient runtime error | Retry the same worker with backoff |
| Worker unavailable | Reroute through declared fallbacks |
| Authentication failure | Block until the user authenticates |
| Task failure | Retry or remediate within policy |
| Verification failure | Feed evidence into a new attempt |
| Integration conflict | Remediate or block |
| Policy violation | Fail without automatic retry |
| Specification problem | Block and escalate to Human/Spec Kit |

Retry policy has explicit attempt and elapsed-time budgets. It never expands
permissions, exposes new credentials, or edits planning artifacts.

## 16. Installation and Environment Contract

`harness init` always materializes a complete editable `workflow.yaml`. It
never creates an empty configuration. The default is the Spec Kit -> Devin ->
Codex -> Pi verification workflow described in this document.

`environment.yaml` declares required versions and capabilities for Pi, Spec
Kit, Superpowers, Herdr, the four Herdr integrations, Codex CLI, Devin CLI,
Claude Code, Git, and optional GitHub tooling. `harness.lock` resolves every
installable source to an exact version or Git commit and records integrity
information.

Node.js 22 or newer is the sole bootstrap prerequisite for the first release.
On a new machine, `node .harness/bootstrap.mjs` reads the lockfile, loads the
matching harness CLI, inspects the machine, presents a complete install plan,
requests one approval, installs missing dependencies, merges project-local Pi
settings, installs Herdr integrations, runs capability and authentication
probes, and writes a secret-free local receipt. A later standalone bootstrap
binary may remove the Node.js prerequisite without changing the project
contract.

Commands include:

```text
harness init
harness bootstrap [--dry-run | --repair | --yes]
harness doctor [--json]
harness explain
harness graph
harness status
harness recover
```

Bootstrap is idempotent. It prefers project-local installation, identifies
global mutations separately, does not overwrite customized workflows, does not
copy credentials, does not remove tools it did not install, and permits
noninteractive approval only for locked sources allowed by trust policy.

## 17. Security and Isolation

Effective permissions are the intersection of machine policy, project policy,
and workflow requests. A freely editable workflow cannot silently weaken the
machine security ceiling.

Workers receive a dedicated worktree, sanitized environment, explicit
credential profile, process/resource limits, protected paths, and declared
network/filesystem permissions. Worktrees isolate edits but are not security
sandboxes; adapters must report whether they provide a native sandbox,
container isolation, or an unrestricted host process. Required isolation is a
preflight capability.

Repositories and executable packages are untrusted before approval. Floating
Git branches are forbidden for unattended installs. Bootstrap previews sources,
versions, checksums, build/install commands, Herdr integration changes, and
global mutations.

Runtime state is gitignored and user-readable only. Logs are bounded and
redacted for known patterns, but redaction is not a substitute for excluding
production secrets. Production credentials are denied by default.

## 18. Operator Experience

Pi exposes semantic workflow commands:

```text
/harness-run
/harness-status
/harness-graph
/harness-task
/harness-logs
/harness-retry
/harness-reroute
/harness-cancel
/harness-pause
/harness-resume
/harness-doctor
```

Herdr remains the place to inspect or interact with the underlying agent
terminal. Pi shows task dependencies, state, selected worker, attempt, Herdr
workspace/agent identity, worktree and branch, commits, tests, evidence,
review, verification, and blockers.

CLI recovery commands may inspect and repair state while Pi is unavailable,
but they do not schedule new work or make orchestration decisions.

## 19. Verification Strategy

The implementation requires:

- Unit tests for workflow compilation, DAG validation, state transitions,
  routing, retries, schemas, and policy intersection.
- Property/invariant tests proving dependency ordering, one active lease,
  bounded retry, deterministic event replay, and verification before `DONE`.
- A shared adapter contract suite executed against fake Codex, Devin, and
  Claude CLIs without consuming subscriptions.
- Git/worktree integration tests for concurrency, dependency commits, dirty
  worktrees, protected-file changes, conflicts, and failed verification.
- Crash tests that terminate Pi, Herdr, workers, and state writes at controlled
  points, then exercise reconciliation.
- Installer tests in temporary repositories and fake home directories covering
  fresh install, dry-run, idempotency, customization preservation, trust,
  lockfile mismatch, partial failure, and repair.
- Gated end-to-end smoke tests with real Pi, Herdr, and worker CLIs.

## 20. First-Release Scope and Build Order

The first usable release includes the Pi extension and CLI, Spec Kit graph
integration, editable default DSL, Herdr local runtime, Codex/Devin/Claude
adapters, Superpowers profiles, parallel DAG execution, worktree isolation,
persistent state, retries/rerouting/blockers, review and verification gates,
integration, final pull-request creation, and install/doctor/recovery commands.

Implementation order is:

```text
Schemas and deterministic core with a fake runtime
  -> Pi extension and Spec Kit integration
  -> Herdr runtime and Codex adapter
  -> Devin adapter and default implementation workflow
  -> Claude adapter
  -> review, verification, integration, and final PR
  -> installer and end-to-end hardening
```

All three worker adapters are required for the first release even though they
are implemented sequentially.

## 21. Acceptance Criteria

The first release is acceptable when all of the following are demonstrated:

1. `harness init` in a clean Git repository creates a complete workflow,
   environment contract, policy, lockfile, and Pi settings that pass preflight
   without requiring the user to author YAML.
2. Cloning that configured repository onto a clean test machine and running the
   bootstrap entrypoint produces an approval plan, installs only locked and
   trusted dependencies, installs the four Herdr integrations, and passes
   `harness doctor` after the user completes required CLI authentication.
3. The Spec Kit integration generates `tasks.md` and a valid, hash-bound
   `task-graph.json`; stale or ambiguous graphs are rejected before execution.
4. At least two independent tasks run concurrently through Herdr in distinct
   branches and worktrees, while a dependent task remains `PENDING` until its
   prerequisites are verified and integrated.
5. Codex, Devin, and Claude each pass the shared adapter contract suite and
   complete a real gated smoke task.
6. A worker completion claim without a valid result, commit, required
   Superpowers evidence, review, tests, and successful integration cannot
   produce task state `DONE`.
7. Pi, Herdr, and worker termination tests recover without duplicate attempts,
   duplicate commits, skipped dependencies, or lost event history.
8. A worker can return a typed planning blocker; Pi preserves its evidence and
   escalates without modifying Spec Kit requirements or architecture.
9. A failed worker can be retried or rerouted according to workflow policy,
   with every attempt and routing decision visible in the run history.
10. A complete sample feature reaches final full-suite verification and creates
    one pull request containing the integrated task commits.

## 22. External References

- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Spec Kit task generation](https://github.com/github/spec-kit/blob/main/templates/commands/tasks.md)
- [Spec Kit task template](https://github.com/github/spec-kit/blob/main/templates/tasks-template.md)
- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
- [Herdr socket API](https://herdr.dev/docs/socket-api/)
- [Herdr integrations](https://herdr.dev/docs/integrations/)
- [Herdr session state and restore](https://herdr.dev/docs/session-state/)
