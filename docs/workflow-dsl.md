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
