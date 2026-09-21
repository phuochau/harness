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
