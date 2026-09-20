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
- After one explicit install-plan approval, provision every missing Pi package,
  Spec Kit integration, Superpowers component, Herdr integration, worker CLI,
  and local tool that has a trusted automated recipe; give exact blocking
  instructions for declared manual dependencies.
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
  |- resident HarnessController
  `- deterministic harness core
       |- workflow compiler
       |- Spec Kit task-graph validator
       |- DAG scheduler
       |- workflow/stage/job/attempt state machines
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

The Pi orchestrator itself runs as a named, resident Pi agent inside a dedicated
Herdr workspace. The extension creates one long-lived `HarnessController` in
that Pi process. The controller is an event-driven deterministic loop that
continues scheduling while the Pi model is idle; it does not require an active
LLM turn and does not consume model tokens to poll workers. Detaching the Herdr
client leaves both Pi and the controller running.

The controller is not a second orchestrator or daemon. It is the runtime part
of the Pi extension and implements only the frozen workflow, state-machine, and
policy decisions owned by Pi. If the Pi process exits, workers already launched
by Herdr may continue, but no new scheduling occurs until Herdr restores Pi and
the extension reacquires the run with a new fencing token and reconciles state.
`harness start` creates or reattaches this dedicated local Herdr workspace and
Pi session.

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
  workflows/
    examples/
      spec-kit-codex.yaml
      spec-kit-devin.yaml
      mixed-workers.yaml
```

Repository-local runtime data, shared by every linked worktree through Git's
common directory:

```text
<git-common-dir>/harness/
  runs/
    F023/
      resolved-workflow.json
      state.json
      events.jsonl
      artifacts/
      assignments/
      workers/
      evidence/
      logs/
```

Machine-local install receipts live in the platform user-state directory, not
inside the repository. On Unix-like systems the default is
`${XDG_STATE_HOME:-~/.local/state}/pi-harness/receipts/`.

The non-bypassable machine security ceiling lives outside the repository at
the platform user-config location; on Unix-like systems the default is
`${XDG_CONFIG_HOME:-~/.config}/pi-harness/policy.yaml`. The committed
`.harness/policy.yaml` may request narrower permissions but cannot replace or
weaken the machine policy.

`.pi/` remains Pi's native namespace. `.harness/` owns harness configuration
only. Runtime state lives under the Git common directory so the control checkout
and all task worktrees resolve the same run. The design does not use a generic
`.ai/` directory.

At run creation, Pi resolves and records the canonical repository root and
`git rev-parse --git-common-dir`. Only the controller writes run state. Worker
assignments receive absolute paths, and task worktrees may write only their
local `.harness-output/` result directory.

## 7. Workflow DSL

A workflow is freely editable project-owned YAML. Profiles are examples, not
restrictions. The engine does not hard-code stage names such as `plan`,
`implement`, or `review`.

```yaml
schema: harness/v1
name: spec-kit-devin

task_model:
  source: stages.tasks.outputs.graph
  complete_when:
    stage: integrate

stages:
  - id: specify
    uses: spec-kit.specify
    runner: pi
    model_profile: chatgpt-planning
    produces:
      spec: feature/spec.md

  - id: plan
    uses: spec-kit.plan
    runner: pi
    model_profile: chatgpt-planning
    needs:
      - stage: specify
        scope: all
    produces:
      plan: feature/plan.md

  - id: approve_plan
    uses: human.approval
    needs:
      - stage: plan
        scope: all

  - id: tasks
    uses: spec-kit.tasks
    runner: pi
    model_profile: chatgpt-planning
    needs:
      - stage: approve_plan
        scope: all
    produces:
      tasks: feature/tasks.md
      graph: feature/task-graph.json

  - id: implement
    uses: worker.execute
    runner:
      prefer: [devin, codex, claude]
    needs:
      - stage: tasks
        scope: all
    foreach:
      source: stages.tasks.outputs.graph
      key: task.id
    gate: task.dependencies_done
    isolation: worktree
    profile: disciplined-engineer

  - id: review
    uses: worker.review
    runner:
      prefer: [codex, claude, devin]
    needs:
      - stage: implement
        scope: same-item
    foreach:
      source: stages.tasks.outputs.graph
      key: task.id
    policies:
      require_different_worker_kind: true
    on_failure:
      changes_requested:
        retry_stage: implement

  - id: verify
    uses: command.run
    needs:
      - stage: review
        scope: same-item
    foreach:
      source: stages.tasks.outputs.graph
      key: task.id
    with:
      command: ${commands.task_verify}

  - id: integrate
    uses: git.integrate
    needs:
      - stage: verify
        scope: same-item
    foreach:
      source: stages.tasks.outputs.graph
      key: task.id

  - id: final_verify
    uses: command.run
    needs:
      - stage: integrate
        scope: all
    with:
      command: ${commands.full_verify}

  - id: final_pr
    uses: github.pull-request
    needs:
      - stage: final_verify
        scope: all
```

Common stage fields are `id`, `uses`, `runner`, `needs`, `if`, `foreach`,
`with`, `policies`, `produces`, `retry`, `timeout`, and `on_failure`.

`${commands.*}` references typed named commands declared in
`environment.yaml`. References are resolved and frozen during compilation;
they are not shell-expanded while parsing YAML.

`uses` names a registered action or an explicit shell action. `runner` chooses
where that action runs. Before a run starts, the compiler validates the schema,
resolves references, checks cycles and capability requirements, intersects
permissions, and freezes the result as `resolved-workflow.json`. Editing
`workflow.yaml` never mutates an active run.

The engine executes four generic entities rather than assuming a software
development sequence:

- A `WorkflowRun` is one immutable resolved workflow execution.
- A `StageRun` is the aggregate execution of one declared stage.
- A `JobRun` is either the single job for a static stage or one fan-out item.
  Its stable item key correlates jobs across stages.
- An `Attempt` is one worker/runtime execution of a job. Retries and reroutes
  create new attempts without creating a new job.

`foreach` fans a stage out into keyed jobs. A dependency with `scope: all` is a
fan-in barrier over every upstream job; `scope: same-item` joins only the
upstream job with the same item key. A missing or duplicate key is a compile
error. Actions may produce typed collections for later fan-out, but an active
run may not dynamically add stages or rewrite the frozen graph.

`on_failure.retry_stage` may target only an ancestor job with the same item key.
It creates a new attempt of that existing job, invalidates downstream results
that depended on the superseded attempt, and then re-evaluates the same frozen
graph. It does not add a stage or job. The compiler rejects unbounded
remediation loops; both the target job and whole run must declare finite
attempt and elapsed-time budgets.

The optional `task_model` projects selected keyed jobs onto Spec Kit tasks.
`task.dependencies_done` is a deterministic gate over the validated task DAG,
and `complete_when.stage` defines which successful keyed job makes that task
complete. This keeps task-aware scheduling explicit without making tasks the
only execution primitive. Workflows without `task_model` remain valid.

The resolved workflow records its content hash. It freezes stage templates and
declared fan-out expressions before execution; jobs declared by `foreach` are
materialized only when their validated source artifact exists. Continuing with
a different workflow creates a new run revision referencing the old run rather
than mutating the active run.

## 8. Spec Kit Contract and Task Graph

Spec Kit remains the source of product intent. Workers may read `spec.md`,
`plan.md`, and `tasks.md`, but may not change requirements, architecture, task
definitions, or acceptance criteria.

The standard Spec Kit task format includes task IDs, phases, parallel markers,
story labels, descriptions, and file paths, but not an explicit dependency
list for every task. The harness therefore ships a versioned
`harness-task-graph` Spec Kit preset. Its tasks command uses Spec Kit's `wrap`
composition strategy around the core task command, adding the graph contract
without copying or forking the upstream prompt. The planning model therefore
emits both the human-readable task list and its machine-readable projection in
one planning operation:

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

Immediately after the task-planning action returns, the controller directly
invokes the deterministic graph validator. The two outputs are accepted as one
artifact set only if their schemas, task identities, acceptance references,
and semantic hash agree. Spec Kit extension hooks may provide convenience
automation, but agent-mediated hooks are never a correctness boundary; the
controller-owned validation call is mandatory even when a hook ran.

Pi refuses execution when the graph has cycles, unknown task IDs, missing
dependencies, invalid acceptance references, a stale semantic hash, or file
ownership conflicts between tasks that the graph would otherwise permit to run
in parallel. File overlap is valid when the graph orders the tasks. Pi never
asks an LLM to guess missing dependencies during execution.

## 9. Persistent State

Each run stores:

- `resolved-workflow.json`: immutable compiled workflow.
- `artifacts/`: content-addressed accepted planning artifacts, including the
  validated task graph once the task-planning stage completes.
- `events.jsonl`: append-only authoritative event history.
- `state.json`: atomically replaced materialized snapshot derived from events.
- Assignment bundles, attempt records, worker/session identifiers, logs, and
  evidence.

Only one controller may own a run lease. The local runtime combines an OS
advisory lock with a durable lease record. Acquiring or recovering that lease
atomically increments a fencing token; every state write and external-action
observation carries the token, and append verifies the current owner while the
lock is held, so a stale controller cannot append valid events after ownership
changes.

Every JSONL event contains a monotonic sequence number, timestamp, run and
entity IDs, idempotency key, fencing token, payload, `prevHash`, and
`eventHash`. An append is flushed and `fsync`ed before the controller acts on
it. External side effects use an intent/observation protocol: Pi first records
an action intent with a stable idempotency key, performs or reconciles the
operation, then records the observed result. Adapters must use that key when
the underlying system supports idempotency and otherwise reconcile by native
session, branch, commit, or worktree identity before retrying.

`state.json` is written to a sibling temporary file, flushed, and atomically
renamed. It records the last applied sequence and event hash. On recovery, an
incomplete final JSONL record may be truncated after preserving a diagnostic
copy; malformed records or hash/sequence breaks anywhere else fail recovery
and require explicit repair. Replaying the same valid event history must always
produce the same state.

After restart, Pi acquires the lease with a new fencing token, verifies the
complete event hash chain, validates the snapshot boundary, applies events
after that boundary, queries Herdr for workspaces and agents, inspects Git state
and worker results, then deterministically reattaches, resumes, retries, blocks,
or verifies each attempt. A side effect with an intent but no observation is
reconciled before the controller may issue another action.

## 10. Job and Task Lifecycle

```text
PENDING
  -> READY
  -> RUNNING
  -> VERIFYING
  -> DONE

Error paths:
  RUNNING or VERIFYING -> RETRY -> READY
  DONE -> RETRY only when a downstream remediation policy invalidates it
  any active state -> BLOCKED
  retry exhaustion or nonrecoverable error -> FAILED
```

The state machine applies to each `JobRun`. For a task-aware workflow, the
human-facing task state is a projection of the keyed jobs selected by
`task_model`: it becomes `RUNNING` when its first job starts, `VERIFYING` after
implementation is submitted, `DONE` only when the declared completion-stage
job succeeds, `BLOCKED` when an active required job is blocked, and `FAILED`
when a required job exhausts policy.

Rules:

- A job becomes `READY` only when its declared stage dependencies, item scope,
  condition, and gate are satisfied.
- A task implementation job remains gated until every task dependency is
  `DONE`.
- A job has at most one active lease and one active worker attempt.
- Worker completion changes its job and projected task to `VERIFYING`, never
  directly to `DONE`.
- `BLOCKED` does not consume retry budget by itself.
- Every retry creates an immutable attempt record.
- Rerouting occurs only between attempts.
- A downstream retry remains bound to the exact upstream attempt generation it
  observed. Retrying an upstream job invalidates dependent results before they
  can be integrated.
- Pi updates a `tasks.md` checkbox only after the task projection reaches
  `DONE`.

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

Planning actions run in a controller-owned planning worktree on the integration
branch and may write only declared Spec Kit artifact paths. After human plan
approval and deterministic task-graph validation, Pi commits the complete
planning artifact set and records its commit and content hashes. Task branches
start no earlier than this planning commit. A workflow that starts from
existing approved artifacts may conditionally skip planning, but it must bind
their paths, hashes, and containing commit before fan-out.

Herdr creates or opens a worktree for each job that requests worktree
isolation. Downstream `same-item` jobs may inherit the upstream artifact,
branch, and worktree reference when their action contract allows it. In the
default workflow, the implementation job creates the task branch and the
review and verification jobs inspect that same branch. A task branch begins
from an integration commit containing all completed dependency commits.
Independent tasks may run concurrently from their appropriate integration
bases.

After worker completion, Pi validates the worker-produced commits, performs
review and task verification, serializes integration into the run branch, and
runs post-integration checks. A conflict leaves the task in `VERIFYING` and
creates a remediation attempt or blocker. `DONE` means the commit is integrated
and post-integration checks passed for the projected task.

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

Each immutable assignment bundle contains workflow, stage, job, attempt, and
item identity; optional task identity and acceptance references; planning-
artifact paths; frozen base information; allowed file scope; required
Superpowers disciplines; verification commands; protected paths; and the
result schema.

Workers write `.harness-output/result.json` inside their task worktree. The
directory is gitignored and may not be included in a task commit. Pi copies and
hashes accepted results and evidence into the run directory.

The normalized result uses `harness/worker-result/v1` and includes:

- Job ID, stable item key, attempt number, and task ID when task-aware.
- Outcome: `completed`, `blocked`, or `failed`.
- Summary and commit SHAs.
- Test commands, exit codes, and evidence paths.
- Superpowers disciplines and evidence.
- A typed blocker with reason, evidence, and suggested change when blocked.
- A resumable native session reference when available.

Action-specific payloads are schema-discriminated. In particular,
`worker.review` must identify the exact implementation attempt and commit tree
reviewed and return `approved`, `changes_requested`, or `blocked` with typed
findings. `changes_requested` triggers the declared remediation policy; an
approval for a superseded commit tree is invalid.

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

Worker profiles use an explicit Superpowers allowlist. The default permits
test-driven development, systematic debugging, verification before completion,
and code-review skills. It excludes planning, global delegation,
subagent-driven development, parallel-agent dispatch, Git-worktree management,
and branch-finishing skills because those would overlap Pi's orchestration or
Herdr's isolation responsibilities. A project may add a skill only when its
declared capabilities do not cross those boundaries.

Adapters report support as `native`, `injected`, or `unsupported`. A stage that
requires `native` support fails preflight when its selected worker cannot
provide it. Native support is evidenced by adapter-observed skill invocation
events. Injected support means the adapter supplied equivalent instructions;
it is evidenced independently through command logs, Git artifacts, tests, and
review results. A worker's self-reported claim that it followed a discipline is
never sufficient. The harness never silently drops a required discipline.

## 15. Routing, Retries, and Blockers

Stages may explicitly name a worker or select by capability and ordered
preference. The general auto-selection preference is Codex, then Devin, then
Claude. The shipped default workflow overrides this by assigning implementation
to Devin, review to Codex, and using Codex then Claude as implementation
fallbacks.

Routing is deterministic and considers only declared order, capabilities,
availability/authentication, concurrency limits, and policy. Every routing
decision is recorded as an event.

The shipped policy requires a review job's worker kind to differ from the
worker kind that produced the implementation it reviews. Thus the normal Devin
implementation is reviewed by Codex; if implementation falls back to Codex,
review routes to Claude and then Devin according to declared review fallbacks.
If no distinct eligible reviewer is available, the review job is `BLOCKED`
rather than waived. Projects may strengthen this rule but the default machine
policy does not permit silently disabling it.

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

During initialization, the trusted CLI derives named verification commands
from declarative project metadata such as package manifests and known build
files. When detection is ambiguous or empty, it asks the operator for the
command values and writes them into `environment.yaml`; the user never has to
author YAML merely to obtain a runnable default. Detected commands are shown
for confirmation and are not executed during bootstrap before approval.

`environment.yaml` declares required versions and capabilities for Pi, Spec
Kit, Superpowers, Herdr, the four Herdr integrations, Codex CLI, Devin CLI,
Claude Code, Git, GitHub CLI, and an authenticated GitHub remote. GitHub is
required in the first release because final pull-request creation is a required
stage; provider-neutral hosting is deferred. `harness.lock` resolves every
installable source to an exact version or Git commit and records integrity
information.

Node.js 22 or newer is the sole bootstrap prerequisite for the first release.
Bootstrap is launched only through a trusted harness CLI installed outside the
repository: either an already installed binary or an exact-version command
from the harness release documentation, such as:

```text
npm exec --yes --package @pi-harness/cli@<exact-version> -- harness bootstrap .
```

The launcher treats `.harness/*.yaml` and `harness.lock` only as declarative
data. It never imports project JavaScript, runs repository shell scripts, loads
Pi extensions, or executes workflow actions before showing the install plan
and receiving approval. It verifies that its own version matches the desired
locked harness version; a mismatch produces an explicit trusted upgrade
command rather than executing repository-provided code.

Each dependency has a typed installer recipe: exact-version `npm`, allowlisted
package-manager formula, signed release artifact with digest, or `manual`.
Bootstrap may automatically execute only recipes permitted by machine trust
policy whose source and integrity match the lock. A manual or unverifiable
dependency blocks completion with exact install instructions and is re-probed
after the operator acts; the harness never substitutes a downloaded arbitrary
install script. Authentication is an explicit interactive follow-up and is
never copied between machines.

After approval, bootstrap installs eligible missing dependencies, merges
project-local Pi settings, installs Herdr integrations, runs capability and
authentication probes, and writes a secret-free local receipt. A later
standalone bootstrap binary may remove the Node.js prerequisite without
changing the project contract.

Commands include:

```text
harness init
harness bootstrap [--dry-run | --repair | --yes]
harness doctor [--json]
harness explain
harness graph
harness start
harness status
harness recover
```

Bootstrap is idempotent. It prefers project-local installation, identifies
global mutations separately, does not overwrite customized workflows, does not
copy credentials, does not remove tools it did not install, and permits
noninteractive approval only for locked sources allowed by trust policy. A
receipt records probes and mutations for diagnostics, but it is not proof of
current machine state; `doctor` always probes again.

## 17. Security and Isolation

Effective permissions are the intersection of machine policy, project policy,
and workflow requests. A freely editable workflow cannot silently weaken the
machine security ceiling.

Starting a workflow is a separate approval boundary from installing its tools.
Before the first action, Pi displays the frozen workflow hash, resolved shell
commands, worker and credential profiles, filesystem/network permissions,
branches, push, and pull-request effects. One run approval authorizes only
those declared effects and bounded retries. A newly resolved command,
permission expansion, changed workflow, or different external destination
requires a new run revision and approval.

Workers receive a dedicated worktree, sanitized environment, explicit
credential profile, process/resource limits, protected paths, and declared
network/filesystem permissions. Worktrees isolate edits but are not security
sandboxes; adapters must report whether they provide a native sandbox,
container isolation, or an unrestricted host process. Required isolation is a
preflight capability.

Repositories and executable packages are untrusted before approval. Floating
Git branches are forbidden for unattended installs. Bootstrap previews sources,
versions, checksums, build/install commands, Herdr integration changes, and
global mutations. Before approval, the trusted external launcher reads only
declarative harness files and Git metadata; no executable content from the
repository is loaded, including package lifecycle scripts, Pi extensions,
workflow shell actions, or project hooks.

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

- Unit tests for workflow compilation, fan-out/fan-in and same-item joins, DAG
  validation, state transitions and projections, routing, retries, schemas,
  and policy intersection.
- Property/invariant tests proving dependency ordering, one active lease,
  bounded retry, deterministic event replay, independent review, and
  verification before `DONE`.
- A shared adapter contract suite executed against fake Codex, Devin, and
  Claude CLIs without consuming subscriptions.
- Git/worktree integration tests for concurrency, dependency commits, dirty
  worktrees, protected-file changes, conflicts, and failed verification.
- Crash tests that terminate Pi, Herdr, workers, and state writes at controlled
  points, including torn final JSONL records, duplicated action intents, stale
  fencing tokens, and interior log corruption, then exercise reconciliation.
- Installer tests in temporary repositories and fake home directories covering
  fresh install, dry-run, idempotency, customization preservation, trust,
  lockfile mismatch, partial failure, repair, and proof that repository code is
  not executed before approval.
- Gated end-to-end smoke tests with real Pi, Herdr, and worker CLIs.
- A longevity test that detaches all clients and leaves the Pi model idle while
  the resident controller observes worker completion and schedules the next
  ready jobs.

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
   environment contract, policy, lockfile, and Pi settings that pass schema and
   configuration preflight without requiring the user to author YAML.
2. Cloning that configured repository onto a clean test machine and running the
   trusted external bootstrap entrypoint produces an approval plan without
   executing repository code, installs only locked and trusted dependencies,
   installs the four Herdr integrations, and passes `harness doctor` after the
   user completes required CLI and GitHub authentication.
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
7. The default workflow enforces a reviewer worker kind different from its
   implementation worker kind, including after fallback routing; absence of an
   eligible independent reviewer blocks the job.
8. Pi, Herdr, and worker termination tests recover without duplicate attempts,
   duplicate commits, skipped dependencies, or lost event history. Recovery
   safely truncates only an incomplete trailing event and rejects interior
   corruption or a stale fencing token.
9. A worker can return a typed planning blocker; Pi preserves its evidence and
   escalates without modifying Spec Kit requirements or architecture.
10. A failed worker can be retried or rerouted according to workflow policy,
   with every attempt and routing decision visible in the run history.
11. With every client detached and the Pi model idle, the resident controller
    continues a multi-stage run; after a forced Pi-process restart it reacquires
    the run, reconciles intent/observation events, and resumes safely.
12. A test workflow demonstrates keyed fan-out, `same-item` joins, an `all`
    fan-in barrier, and task-state projection without hard-coded stage names.
13. A complete sample feature reaches final full-suite verification and creates
    one pull request containing the integrated task commits.

## 22. External References

- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Spec Kit task generation](https://github.com/github/spec-kit/blob/main/templates/commands/tasks.md)
- [Spec Kit task template](https://github.com/github/spec-kit/blob/main/templates/tasks-template.md)
- [Spec Kit presets](https://github.com/github/spec-kit/blob/main/docs/reference/presets.md)
- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
- [Herdr socket API](https://herdr.dev/docs/socket-api/)
- [Herdr integrations](https://herdr.dev/docs/integrations/)
- [Herdr session state and restore](https://herdr.dev/docs/session-state/)
