# Workflow DSL

Every initialized project receives an immediately runnable
`.harness/workflow.yaml`. The controller validates, compiles, and hashes it
before creating a run. Provider choice is expressed with profile IDs:

```yaml
schema: harness/v1
name: spec-kit-multi-agent
task_model:
  source: stages.tasks.outputs.graph
  complete_when: { stage: record_task_done }
stages:
  - id: specify
    uses: spec-kit.specify
    runner: planner-codex
    produces: { spec: specs/feature/spec.md }

  - id: plan
    uses: spec-kit.plan
    runner: planner-codex
    needs: [{ stage: specify, scope: all }]
    produces: { plan: specs/feature/plan.md }

  - id: approve_plan
    uses: human.approval
    needs: [{ stage: plan, scope: all }]

  - id: tasks
    uses: spec-kit.tasks
    runner: planner-codex
    needs: [{ stage: approve_plan, scope: all }]
    produces:
      tasks: specs/feature/tasks.md
      graph: specs/feature/task-graph.json

  - id: implement
    uses: worker.execute
    runner: { prefer: [implementer-codex, implementer-devin] }
    needs: [{ stage: tasks, scope: all }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    gate: task.dependencies_done
    isolation: worktree
    retry: { max_attempts: 3, max_elapsed_seconds: 86400 }

  - id: review
    uses: worker.review
    runner: { prefer: [reviewer-codex, reviewer-devin] }
    needs: [{ stage: implement, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    policies: { require_different_profile_family: true, scope: task }

  - id: verify
    uses: command.run
    needs: [{ stage: review, scope: same-item }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    with: { argv: "${commands.task_verify}" }

  - id: integrate
    uses: git.integrate
    needs: [{ stage: verify, scope: same-item }]
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

The packaged default also contains `post_integrate_verify` and
`record_task_done`; inspect `src/defaults/workflow.yaml` for the canonical full
file.

## Task-kind selection

`/harness-run <id>` compiles `.harness/workflow.yaml` and runs the full
multi-agent Spec Kit pipeline. Three task kinds select among fixed,
project-owned workflows:

```text
/harness-run <id> --kind bugfix -- <literal brief>
/harness-run <id> --kind small-feature -- <literal brief>
/harness-run <id> --kind large-feature [-- <brief>]
```

An agent may suggest a kind, but the suggestion is advisory only: the operator
explicitly approves the shown workflow, and may rerun the command with a
different `--kind` before approving. Unknown kinds and external workflow paths
are rejected; there is no agent-generated DAG. This release does not run an
automatic LLM classifier — ambiguous or unflagged work defaults to
`large-feature`.

- `bugfix` and `small-feature` compile `.harness/workflows/bugfix.yaml` or
  `small-feature.yaml` (installed by `harness init`). They open with a single
  durable `harness.quick-plan` stage that produces `spec.md`, `plan.md`, and
  `tasks.md` in one correlated planning turn; the controller derives,
  validates, and seals `task-graph.json`. The task list must contain exactly
  one non-parallel task with the matching kind label, at least one owned path,
  and at least one acceptance reference. Every downstream gate is unchanged:
  independent review, per-task verification, integration, post-integration
  verification, task finalization, final verification and review, push, and
  PR. There is no separate plan-approval stage because the operator approval
  itself is the gate.
- `large-feature` keeps `.harness/workflow.yaml`, including `approve_plan`.
  An explicit `--kind large-feature -- <brief>` run injects the brief into
  `spec-kit.specify`; the unflagged form leaves the workflow untouched.

Quick planning currently emits v1 task metadata, so its presets use
`runner.prefer`. A quick preset with `runner.by_complexity` is rejected during
preview because tiered routing requires a v2 task complexity assessment.

The text after `--` is literal data. It is never executed, resolved as a path,
or interpolated into the workflow — the harness injects it into the selected
workflow's planning stage after compilation.

The preview binds the kind, brief, selected workflow revision, commands,
profiles, permissions, and effect kinds into one hash. If the kind, brief, or
preset file changes before approval, the stale hash is rejected. Once approved,
the selected workflow and brief are frozen in the run's resolved configuration;
recovery replays that frozen selection even if the project presets change
afterward.

## Change the workflow

Edit `runner.prefer` to change routing without changing orchestration code. For
example, `[implementer-devin, implementer-codex]` makes Devin the primary
implementer. Profiles bind a family, provider, model, explicit tools,
extensions, skills, prompt templates, and MCP resources. A new provider is
added by declaring and locking its profile resources, then referencing that
profile from the workflow.

The current default inventory declares Codex CLI and Devin CLI only. The core
profile schema is intentionally provider-extensible; adding another provider
does not create another global orchestrator.

## Complexity-aware implementer routing

A task-scoped `worker.execute` stage may opt into tiered routing with the closed
`by_complexity` runner form:

```yaml
  - id: implement
    uses: worker.execute
    runner:
      by_complexity:
        mechanical: [implementer-fast]
        standard: [implementer-standard]
        complex: [implementer-strong]
    needs: [{ stage: tasks, scope: all }]
    foreach: { source: stages.tasks.outputs.graph, key: task.id }
    gate: task.dependencies_done
    isolation: worktree
    retry: { max_attempts: 3, max_elapsed_seconds: 86400 }
```

All three tiers are required. Each names one or more profile IDs declared in
`.harness/profiles.yaml` with `role: implementation`, unique across tiers. Tier
order is `mechanical < standard < complex`. The form is valid only on a
task-scoped `worker.execute` stage; review, planning, and other stages keep
`runner: <profile>` or `runner: { prefer: [...] }`.

The Spec Kit tasks stage then assesses every task: the planner writes
`| complexity=<tier> | why="<reason>" |` into each tasks.md line and the v2 task
graph (`harness/task-graph/v2`) carries matching `complexity` /
`complexityReason` fields. A tiered runner paired with a v1 task graph fails at
preflight with a migration instruction — reseal `tasks.md` through the tasks
stage. Legacy runners continue to accept v1 (and v2) graphs unchanged.

### Initial route and capability preflight

At run creation the controller probes each declared candidate once — provider
registered, exact model row in the profile's `pi --list-models` output,
authentication ready, managed resources verified — and freezes the capability
snapshot in the run's durable configuration. See
[coding model profiles](model-profiles.md) for declaring, discovering, and
authenticating a profile.

Initial selection tries the task's tier in declaration order and falls **upward
only**: a `mechanical` task may land on `standard` or `complex`, but a task is
never silently routed to a weaker tier. When no declared candidate at or above
the task's tier is ready, the job blocks with `no_available_profile` and
per-profile evidence. The accepted route — task, assessment, candidates,
selected profile and actual tier — is journaled and replayed identically after
a controller restart; a later catalog or auth change cannot silently substitute
a different profile.

### Review-driven fix rounds

`retry.max_attempts` remains a per-generation execution-retry budget; review
findings use a separate durable `fixRound` counter. Only an accepted task review
with `changes_requested` consumes a fix round — launch failures, transport
errors, and `verification_failed` retries do not.

- **Rounds 1–3** resume the same managed Pi session on the originally selected
  profile and tier, with the review findings and the verified handoff report.
- **Rounds 4–5** start a fresh transcript on a declared profile at least one
  tier stronger than the original actual tier.
- After a fifth reviewed round, or when no stronger ready profile exists, the
  task blocks (`fix_rounds_exhausted` or `no_escalation_profile`) and the open
  findings stay recorded for operator adjudication. The task is never marked
  done while findings are unresolved.

`harness status <run-id>` shows each task's assessed complexity and reason,
selected tier/profile, `fixRound`, pending findings, and any routing block under
`tasks.<task-id>`; `implementationLineages` holds the full accepted lineage.
`harness explain <run-id> T001` returns the journaled route, review, fix
dispatch, and block events for that task, and `harness graph <run-id>`
annotates each job node with its worker, accepted route, and blocker. In Pi,
`/harness-task T001` shows the same routing and lineage detail.

### Operator reroute

An operator may reroute a blocked or failed task (`/harness-reroute` in Pi, or
the `reroute` operator intent) to any profile declared by the implementation
stage — including a lower tier. A reroute is journaled with cause
`operator_reroute`, never resets `fixRound`, and a profile change always starts
a fresh Pi transcript rather than appending to the previous model's session.

## DAG and concurrency rules

- `foreach` creates one keyed job per task.
- `scope: same-item` joins the same task key.
- `scope: all` waits for every upstream job.
- `gate: task.dependencies_done` enforces the task DAG.
- Independent tasks may run concurrently only in distinct worktrees.
- Tasks with overlapping owned paths are not parallel-eligible.
- Review must use a different profile family from implementation when the
  policy is enabled.

Workers can report completion, failure, or a blocker, but only Pi can advance
a task to `DONE` after evidence, tests, review, integration, and task projection
all succeed.

Commands in `environment.yaml` are argv arrays, never shell strings. Changing
the workflow, profiles, commands, retry policy, or review policy changes the
compiled workflow revision and therefore the run identity.
