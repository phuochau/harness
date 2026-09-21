# Pi-Native Multi-Agent Orchestrator Harness Design

**Date:** 2026-09-21

**Status:** Proposed written specification

**Supersedes:** `2026-09-20-pi-multi-agent-orchestrator-design.md`

## 1. Purpose

Build an installable, local-first harness that can execute a large feature over
hours or days from Spec Kit artifacts to a verified pull request. Pi is the
only harness-facing agent host and the only global orchestrator. Codex CLI and
Devin CLI are the release providers selected inside Pi worker profiles rather
than separate top-level runtimes. The profile and workflow contracts remain
extensible to later providers. A provider package may retain its native inner
agent loop, but that loop receives one bounded assignment and has no global
scheduling authority.

The harness must survive controller, worker, context, and machine restarts by
deriving truth from durable state, Git, worktrees, Pi session transcripts, and
structured evidence rather than an LLM context window.

The ready-to-use workflow installed into a new project is:

```text
Human
  -> Pi + local ChatGPT subscription
  -> Spec Kit produces spec.md, plan.md, tasks.md
  -> harness seals task-graph.json
  -> Pi schedules READY task jobs
  -> Pi + Devin implements each task in an isolated worktree
  -> Pi + Codex reviews the exact candidate commit
  -> deterministic tests and integration gates run
  -> Pi performs final review and creates the final pull request
```

That sequence is a default, not hard-coded control flow. Projects may change
the workflow DAG, profiles, provider order, gates, commands, retry policy, and
review policy without modifying harness source.

## 2. Success Criteria

The first releasable version is successful only when all of the following are
true:

1. `harness init` gives a new Git project a valid workflow DSL it can run
   immediately after authentication.
2. `harness setup` creates an isolated managed runtime and installs only the
   exact packages, skills, and extensions declared by the lock and approved by
   the operator.
3. `harness doctor` proves Node, Pi, Git, Spec Kit, profiles, package integrity,
   provider authentication, worktree support, and configured verification
   commands are ready without exposing credentials.
4. Planning runs through Pi with the `openai-codex` provider and a local
   ChatGPT subscription, and Spec Kit remains the planning source of truth.
5. Implementation can run through Pi with Devin or Codex, review can run
   through Pi with Codex or Devin, and any role can be reassigned through
   profile data.
6. Independent tasks run concurrently in distinct branches and worktrees;
   dependent tasks start only after their dependencies are `DONE`.
7. A worker never marks its own task `DONE`. Only controller-owned review,
   verification, integration, and projection gates can do so.
8. Killing Pi, a worker, or the controller at tested crash boundaries does not
   duplicate an external effect or lose accepted work. Recovery either
   reconciles, resumes an exact session, creates a new attempt, or blocks with
   evidence.
9. No undeclared global Pi extension, skill, prompt template, context file,
   Devin plugin, or MCP server appears in a worker context.
10. A real disposable end-to-end test proves Spec Kit planning through Codex,
    implementation through Devin, independent review through Codex,
    Git integration, final verification, package installation, and restart
    recovery using the user's local subscriptions.

## 3. Responsibility Boundaries

| Layer | Responsibility |
|---|---|
| Human | Product decisions, approvals, credentials, and planning conflicts |
| Spec Kit | Requirements, architecture, acceptance criteria, plan, and task definitions |
| Pi orchestrator | Own the resident controller and expose semantic operator commands |
| Harness core | Deterministic workflow compiler, scheduler, state machine, policies, and effect protocol |
| PiWorkerRuntime | Launch and observe every planner, implementer, and reviewer as a Pi session |
| Pi profile | Select provider, model, resources, tools, environment, and role policy |
| Codex/Devin | Perform the assigned planning, coding, or review work inside Pi |
| Superpowers | TDD, debugging, review, and verification discipline inside coding workers |
| Git/tests/CI | Isolation, integration, and executable correctness evidence |

Pi is the only global orchestrator. The deterministic controller is part of the
Pi harness extension; it is not an independent agent and makes no product or
planning decisions. Provider integrations never schedule tasks or decide
completion.

## 4. Chosen Approach and Rejected Alternatives

### 4.1 Chosen: one Pi runtime with explicit profiles

Every agent turn uses the same `PiWorkerRuntime`. A profile supplies the
provider-specific differences. The controller therefore reasons about one
launch, observation, result, cancellation, and recovery contract.

Devin support initially uses pinned package
`@tian.zuo/pi-devin-acp@0.3.4`. The package runs the native `devin acp` agent
loop through Pi. It is hidden behind the harness profile/runtime interface, so
the package can be upgraded, forked, or replaced without changing workflows.

Claude and other providers are deferred. They may later use the same profile
and runtime contracts, but no Claude package, authentication, profile, or
release gate is installed by this Codex-and-Devin release.

This approach preserves actual Devin behavior, keeps Pi in control of all
worker sessions, and was proven by the feasibility spike.

### 4.2 Rejected for the MVP: Devin as a model-only provider

Packages such as `pi-devin-local` let Pi own the full agent loop and use Devin
only for model completions. That is simpler conceptually but is not equivalent
to assigning work to a Devin agent. The inspected package also calls an
unofficial reverse-engineered gRPC/protobuf endpoint. It is too brittle for the
default production path.

### 4.3 Deferred fallback: owned ACP adapter

The official `@agentclientprotocol/sdk` and `devin acp` make an owned adapter
possible. A full implementation must handle initialization, capabilities,
session creation/loading, prompts, cancellation, streaming, permissions,
usage, cleanup, and error mapping. The harness will fork or replace the pinned
ACP package only when compatibility failures justify that maintenance cost;
the Node warning alone is not such a failure.

### 4.4 Removed: Herdr

Herdr is not installed, probed, started, or referenced by the production
runtime. Pi processes, durable records, and Git worktrees provide the required
execution and recovery boundaries directly. Remote access, phone control, Pi
Web, and multi-machine execution remain outside this release.

## 5. Architecture

```text
Orchestrator Pi process
  |- harness extension and semantic commands
  `- durable HarnessController
       |- workflow compiler and immutable resolved DAG
       |- Spec Kit artifact validator
       |- scheduler and lifecycle reducer
       |- routing, retry, review, and security policies
       |- append-only event/effect store
       |- Git/worktree and verification actions
       `- PiWorkerRuntime
            |- planner-codex profile
            |- implementer-devin profile
            |- implementer-codex profile
            |- reviewer-codex profile
            `- reviewer-codex profile
```

The publishable unit is one TypeScript npm package containing the Pi extension,
CLI, contracts, controller, direct Pi runtime, Spec Kit integration, Git
actions, installer, and default workflow/profile assets.

`harness start` launches or reattaches the orchestrator Pi process. An
interactive Pi command and the CLI call the same composition root. The
controller schedules from events and timers without asking the orchestration
model to poll. If that Pi process exits, no new jobs are scheduled until
`harness recover` or a new `harness start` acquires the fenced lease and
reconciles the run.

Worker Pi processes are ordinary child processes. They are never nested
orchestrators: an assignment contains one bounded role, one worktree, one
allowed file scope, one result schema, and no delegation capability.

## 6. Project and Machine Layout

Committed project configuration:

```text
.pi/
  settings.json                 # harness extension only

.harness/
  workflow.yaml                 # immediately usable default workflow
  profiles.yaml                 # project profile selection and fallbacks
  environment.yaml              # typed verification commands
  policy.yaml                   # project restrictions only
  harness.lock                  # exact versions, sources, integrity hashes
  workflows/
    examples/
      codex-devin-codex.yaml
      codex-only.yaml
      mixed-reviewers.yaml
```

Runtime data shared by every linked worktree:

```text
<git-common-dir>/harness/runs/<run-id>/
  resolved-workflow.json
  resolved-profiles.json
  state.json
  events.jsonl
  artifacts/
  assignments/
  attempts/<attempt-id>/
    manifest.json
    session/
    events.jsonl
    stderr.log
    result.json
  evidence/
  logs/
```

Machine-owned managed runtime:

```text
${XDG_DATA_HOME:-~/.local/share}/pi-harness/
  runtimes/<runtime-version>/
    packages/
    skills/
    profiles/<profile-id>/
      home/
      pi-agent/
      xdg-config/
      xdg-data/
  receipts/
```

Machine security policy lives at
`${XDG_CONFIG_HOME:-~/.config}/pi-harness/policy.yaml`. A repository policy may
narrow that policy but cannot widen it. The design does not use `.ai/` and does
not store credentials or mutable run state in the repository.

## 7. Workflow and Profile DSL

The workflow remains generic. Stage names such as `plan`, `implement`, and
`review` are conventions in shipped assets, not engine keywords.

```yaml
schema: harness/v1
name: spec-kit-default

defaults:
  runner_preference: [codex, devin]

task_model:
  source: stages.tasks.outputs.graph
  complete_when:
    stage: record_task_done

stages:
  - id: specify
    uses: spec-kit.specify
    runner: planner-codex
    produces: { spec: specs/current/spec.md }

  - id: plan
    uses: spec-kit.plan
    runner: planner-codex
    needs: [{ stage: specify, scope: all }]
    produces: { plan: specs/current/plan.md }

  - id: approve_plan
    uses: human.approval
    needs: [{ stage: plan, scope: all }]

  - id: tasks
    uses: spec-kit.tasks
    runner: planner-codex
    needs: [{ stage: approve_plan, scope: all }]
    produces:
      tasks: specs/current/tasks.md
      graph: specs/current/task-graph.json

  - id: implement
    uses: worker.execute
    runner: { prefer: [implementer-devin, implementer-codex] }
    needs: [{ stage: tasks, scope: all }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    gate: task.dependencies_done
    isolation: worktree

  - id: review
    uses: worker.review
    runner: { prefer: [reviewer-codex, reviewer-devin] }
    needs: [{ stage: implement, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    policies: { require_different_profile_family: true }
    on_failure:
      changes_requested: { retry_stage: implement }

  - id: verify
    uses: command.run
    needs: [{ stage: review, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    with: { argv: "${commands.task_verify}" }
    on_failure:
      verification_failed: { retry_stage: implement }

  - id: integrate
    uses: git.integrate
    needs: [{ stage: verify, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }

  - id: post_integrate_verify
    uses: command.run
    needs: [{ stage: integrate, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    with: { argv: "${commands.task_verify}" }

  - id: record_task_done
    uses: git.project-task-status
    needs: [{ stage: post_integrate_verify, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }

  - id: final_verify
    uses: command.run
    needs: [{ stage: record_task_done, scope: all }]
    with: { argv: "${commands.full_verify}" }

  - id: final_review
    uses: worker.review
    runner: { prefer: [reviewer-codex, reviewer-devin] }
    needs: [{ stage: final_verify, scope: all }]
    policies: { scope: final_diff }

  - id: push
    uses: git.push
    needs: [{ stage: final_review, scope: all }]

  - id: final_pr
    uses: github.pull-request
    needs: [{ stage: push, scope: all }]
```

The global fallback order is Codex, then Devin. The ready-to-use workflow
intentionally chooses Devin first for implementation and Codex first for
planning/review. This satisfies the desired initial use case while keeping the
engine and all preferences editable.

Profiles are declarative:

```yaml
schema: harness/profiles/v1

profiles:
  planner-codex:
    family: codex
    runtime: pi
    provider: openai-codex
    model: openai-codex/gpt-5.6-luna
    thinking: high
    role: planning
    environment: isolated
    tools: [read, grep, find, ls, write, edit]
    extensions: []
    skills: []
    context_files: false
    prompt_templates: [spec-kit]
    mcp: []

  implementer-devin:
    family: devin
    runtime: pi
    provider: devin
    model: devin/swe-2
    role: implementation
    environment: isolated
    tools: [read, bash, edit, write, grep, find, ls]
    extensions: [npm:@tian.zuo/pi-devin-acp@0.3.4]
    skills:
      - id: superpowers:using-superpowers
        targets: [pi, provider]
      - id: superpowers:test-driven-development
        targets: [pi, provider]
      - id: superpowers:systematic-debugging
        targets: [pi, provider]
      - id: superpowers:verification-before-completion
        targets: [pi, provider]
    context_files: false
    prompt_templates: []
    mcp: []

  reviewer-codex:
    family: codex
    runtime: pi
    provider: openai-codex
    model: openai-codex/gpt-5.6-luna
    thinking: high
    role: review
    environment: isolated
    tools: [read, bash, grep, find, ls]
    extensions: []
    skills:
      - id: superpowers:verification-before-completion
        targets: [pi]
    context_files: false
    prompt_templates: []
    mcp: []

```

The lock resolves symbolic resources such as `spec-kit` and `superpowers:*` to
exact sources and integrity hashes. A workflow references profile IDs, never a
package path or credential. `targets: [pi]` passes a skill explicitly to Pi.
`targets: [provider]` additionally materializes that exact skill into a
provider-native managed location when the provider has its own skill loader.
For Devin this is the managed profile's `.agents/skills`. The resolver rejects
a target unsupported by the profile provider.

The release ships planner, implementer, and reviewer variants for Codex and
Devin:

| Family | Pi provider | Locked integration | Subscription path |
|---|---|---|---|
| Codex | `openai-codex` | Pi built-in provider | ChatGPT OAuth through managed Pi auth |
| Devin | `devin` | `@tian.zuo/pi-devin-acp@0.3.4` | Native Devin CLI/ACP login |

Each family must pass the same worker contract. A missing or unauthorized
family is reported as unavailable and routing proceeds only when the workflow
permits a fallback; it never changes billing mode implicitly.

## 8. Managed Runtime and Installation

Node.js `>=22.22.2` is required. Pi `0.86.1`,
`@junghanacs/pi-shell-acp@0.11.1`, and `@tian.zuo/pi-devin-acp@0.3.4` are pinned
for the initial release. The Node floor is intentional: the Devin extension's
transitive `which@7` dependency declares
`^22.22.2 || ^24.15.0 || >=26.0.0`.

`harness setup` performs four phases:

1. Read only trusted declarative files and probe the machine.
2. Show a complete install plan with exact versions, sources, integrity,
   destination, and whether an operation is automatic or interactive.
3. After one explicit approval, materialize a versioned managed runtime and
   write receipts. It never removes or changes the user's global Pi packages,
   Devin plugins, Codex skills, MCP configuration, or shell configuration.
4. Run `harness doctor` against the managed runtime and report remaining auth
   actions separately.

Each worker launch sets all of these explicitly:

```text
HOME=<managed-profile>/home
PI_CODING_AGENT_DIR=<managed-profile>/pi-agent
XDG_CONFIG_HOME=<managed-profile>/xdg-config
XDG_DATA_HOME=<managed-profile>/xdg-data
PI_CODING_AGENT_SESSION_DIR=<run-attempt>/session
```

Pi is invoked with discovery disabled:

```text
--no-extensions
--no-skills
--no-prompt-templates
--no-context-files
--no-themes
```

The runtime then appends only explicit `--extension`, `--skill`,
`--prompt-template`, and `--tools` arguments from the resolved profile. Project
or global settings cannot silently add resources. Devin is also launched under
the managed `HOME` and XDG roots so it cannot discover the user's global
`~/.agents/skills`, `~/.config/devin`, plugins, or MCP servers.

Provider-native resource projection is likewise allowlisted. For Devin, setup
creates only the selected managed `.agents/skills` entries and no plugins or
MCP config.

Authentication is machine-local and never committed or copied into evidence.
`harness auth <profile>` runs the provider's normal interactive login inside
the managed profile. Existing OS-keychain credentials may be reused when the
provider supports it; otherwise the user logs into the same subscription once
for the managed profile. `harness auth <profile> --reuse-local` is the explicit
opt-in path for copying the selected provider's allowlisted local credential;
opening the extension never imports credentials. Doctor uses non-credential
readiness checks.

## 9. PiWorkerRuntime Contract

The direct runtime exposes one provider-neutral contract:

```ts
interface PiWorkerRuntime {
  probe(profile: ResolvedProfile): Promise<ProfileCapabilities>;
  prepare(assignment: WorkerAssignment): Promise<PreparedAttempt>;
  launch(prepared: PreparedAttempt): Promise<WorkerHandle>;
  observe(handle: WorkerHandle): Promise<WorkerObservation>;
  recover(prepared: PreparedAttempt, record: AttemptRecord): Promise<RecoveryDecision>;
  cancel(handle: WorkerHandle): Promise<CancellationEvidence>;
  collect(prepared: PreparedAttempt): Promise<WorkerResult>;
}
```

`launch` starts Pi in JSON mode with a deterministic attempt session ID and
session directory. The runtime records the executable, argument hash,
environment-key allowlist, PID, process start identity, Pi session path,
profile hash, assignment hash, stdout event path, and stderr path before the
attempt can become `RUNNING`.

The runtime parses structured Pi JSON events. A terminal `turn_end` is not
success by itself. Collection requires a terminal assistant result matching
the closed worker-result schema, a clean process boundary, the expected
assignment/profile IDs, and role-specific evidence.

Workers may read the sealed Spec Kit artifacts but cannot modify them. An
implementation result includes the exact base/head commits, changed paths,
commands run, test results, and blockers. A review result binds to the exact
candidate commit and contains approval or actionable findings. A planner result
binds to the expected artifact paths and pre/post hashes.

## 10. Process Lifecycle and Recovery

Starting a worker is a reconcilable external effect. The durable launch intent
is written before spawning. The child writes only to its worktree, attempt
session directory, and append-only logs.

After controller restart, recovery checks in this order:

1. If the recorded process identity is alive and matches the executable and
   attempt token, reattach observation to its event files.
2. If the process is gone but the Pi transcript contains a valid terminal
   result and Git/evidence agree, collect it exactly once.
3. If Pi and the provider prove the exact session can load or resume, start a
   continuation bound to that session and the same attempt generation.
4. Otherwise mark the old attempt interrupted and create a new attempt from
   durable assignment, worktree, and Git state.

Provider session IDs are optimization hints, not durable truth. The feasibility
spike proved completed Devin ACP sessions can load, but an interrupted Devin
session may restart with a different ACP session ID. The harness therefore
never claims transparent continuation unless identity is proven.

Cancellation sends a graceful interrupt, waits a finite policy duration, then
terminates the matching process tree. A PID without matching start identity or
attempt token is never signaled. Cancellation evidence is durable before a new
attempt launches.

## 11. Spec Kit and Task Graph Contract

Spec Kit owns `spec.md`, `plan.md`, and `tasks.md`. The harness ships a versioned
Spec Kit preset that adds explicit task metadata without forking upstream
prompts. Controller code, not the model, deterministically parses and seals
`task-graph.json`.

The graph records task IDs, descriptions, phases, dependencies, parallel
eligibility, file scope, acceptance references, and a semantic hash of task
definitions. Checkbox state is excluded from the semantic hash so the
controller may project `DONE` back to `tasks.md`; semantic edits invalidate the
graph.

Execution is refused for cycles, unknown dependencies, stale hashes, duplicate
IDs, unsafe paths, invalid acceptance references, or file overlaps between
tasks that can run concurrently. Missing dependencies are never guessed by an
execution worker.

## 12. Scheduling, Worktrees, and Completion

Lifecycle:

```text
PENDING -> READY -> RUNNING -> VERIFYING -> DONE
                      |            |
                      +-> RETRY <---+
                      +-> BLOCKED
                      `-> FAILED
```

A task is `READY` only when all graph dependencies are `DONE`, workflow gates
pass, file-scope concurrency rules permit it, and a matching profile is ready.
Independent `[P]` tasks may run concurrently subject to configured limits.

Each implementation attempt gets a writable branch and worktree. Review and
verification use separate detached worktrees pinned to the candidate commit.
No two active workers receive the same working directory. The integration
branch is mutated only through a serialized compare-and-swap effect.

Worker success moves a task into verification. Only an independent review,
declared tests, exact-range Git validation, integration, post-integration
verification, and the configured completion-stage observation can make it
`DONE`.

## 13. Durable State and Effect Safety

`events.jsonl` is authoritative; `state.json` is an atomically replaced cache.
Every event has a monotonic sequence, run/entity IDs, idempotency key, fencing
token, previous hash, and event hash. One controller owns a run lease; every
write validates the current fencing token.

All external actions use durable intent/observation pairs and declare one
recovery class: `idempotent`, `reconcilable`, or `non_retryable`. An unresolved
non-retryable effect becomes `BLOCKED` rather than running twice. Commands from
Pi, timers, processes, and operators enter one serialized queue. A complete
decision batch is sealed before its members execute so recovery cannot derive a
different partial decision from restart time or new I/O.

Recovery verifies the journal hash chain, snapshot boundary, run lock,
worktrees, refs, process identities, Pi transcripts, results, and outstanding
effect intents before scheduling new work.

## 14. Security Model

- No production database, production API key, infrastructure secret, or
  undeclared host credential is provided to workers.
- Profiles use minimum tools and empty MCP lists by default.
- A project cannot widen machine policy or inject pre-approval executable code.
- Package installs require exact source and integrity matches from the release
  manifest and effective policy.
- Prompts, terminal prose, and repository files are untrusted input; only
  validated structured results and independent evidence change lifecycle.
- Worker prompts explicitly forbid changing Spec Kit artifacts, harness
  configuration, or architecture.
- Secrets are redacted from logs, events, diagnostics, and evidence bundles.

## 15. Operator Surface

Pi commands and CLI commands share semantics:

```text
harness init
harness setup
harness doctor
harness auth <profile>
harness start [feature]
harness status [run]
harness graph [run]
harness explain <run> <job>
harness retry <run> <job>
harness reroute <run> <job> <profile>
harness cancel <run> <job>
harness recover [run]
```

`status`, `graph`, and `explain` are read-only. Mutating commands become durable
operator intents and are subject to the same lease, fencing, and policy checks
as automated decisions.

## 16. Verification Strategy

Testing is layered:

1. Unit tests for schemas, compiler, graph, scheduler, reducer, profile
   resolution, result parsing, and recovery decisions.
2. Contract tests that run the same `PiWorkerRuntime` behavior against fake
   provider profiles, with Codex and Devin required by the release gate.
3. Integration tests for managed HOME/XDG isolation, explicit resource
   allowlists, Pi JSON streams, process observation/cancellation, Git
   worktrees, Spec Kit artifacts, install receipts, and package integrity.
4. Crash/race tests at every intent/observation and process boundary.
5. Packed-consumer tests that install the generated npm tarball into a fresh
   repository and run `init`, `setup --plan`, and `doctor`.
6. Opt-in subscription E2E using real local authentication: Codex planning,
   Devin implementation with Superpowers TDD, independent review, tests,
   integration, controller restart, and final result.

Normal CI never spends subscription usage. A release candidate is not complete
until the real E2E has been run deliberately on an authenticated machine and
its redacted evidence is stored with the run.

## 17. Migration from the Existing Branch

The current branch contains valuable durable-core and Git work plus a Herdr
execution layer. Migration is selective:

Keep and adapt:

- Contracts, workflow compiler, DAG materialization, scheduler, lifecycle, and
  policy logic.
- Fenced journal, snapshots, recovery, command queue, effect registry, and
  deterministic reducer.
- Spec Kit artifact parsing/sealing and Pi planning correlation.
- Git branches, isolated worktrees, verification, integration, task projection,
  push, and pull-request actions.
- Installer trust model, receipts, CLI composition root, and packed-package
  verification.

Replace or remove:

- `src/runtime/herdr/**` and every Herdr release/install requirement.
- `HerdrProductionWorkerRuntime` and Herdr event source types.
- Separate Codex/Devin/Claude CLI adapter classes.
- Herdr compatibility tests, fixtures, fault points, documentation, scripts,
  and package metadata.

Add:

- Managed runtime/profile contracts and resolver.
- Direct Pi process runner, event store, observation, cancellation, and
  recovery implementation.
- Profile-specific readiness/auth diagnostics.
- Isolation tests proving global packages, skills, plugins, MCP, prompt
  templates, and context files do not leak.
- Real Pi-native Codex-to-Devin-to-review E2E.

Existing uncommitted fixes are preserved only when they remain valid under this
spec and pass the rewritten tests. Passing Herdr tests are baseline evidence,
not proof of the Pi-native design.

## 18. Release and Completion Gates

The harness is complete only when:

- Typecheck, build, unit, contract, integration, crash/race, and fake E2E suites
  pass.
- `npm pack` contains only intended runtime assets and installs in a clean
  consumer project.
- Search and dependency inspection show no production Herdr reference.
- A managed worker context contains only its declared resources.
- Node `>=22.22.2`, Pi, provider packages, Spec Kit, and Superpowers are locked
  and diagnosed accurately.
- Real local-subscription E2E passes with redacted evidence.
- A final independent whole-branch review has no unresolved findings.
- The exact reviewed commit is pushed and the final pull request is created and
  attached to the task.

Unit tests or a successful toy spike alone are not completion evidence.

## 19. Non-Goals for This Release

- Herdr or any other second orchestration/execution plane.
- Tailscale, Pi Web, phone control, dashboards, or remote/multi-machine runs.
- Windows service supervision.
- Automatic changes to product requirements, architecture, or Spec Kit task
  definitions.
- LLM-invented dependencies, routing policies, or completion decisions.
- A workflow/plugin marketplace.
- Production credentials or deployment automation.
