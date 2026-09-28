# Task-Kind Workflow Routing Implementation Plan

> **Execution:** Devin CLI SWE-2 Max, in this isolated worktree. Follow superpowers:executing-plans, test-driven-development, systematic-debugging, and verification-before-completion. Commit each independently testable task.

**Goal:** Choose a validated workflow per run for `bugfix`, `small-feature`, or `large-feature`, with advisory agent classification, operator override before approval, and a one-turn quick planning path for the first two kinds.

**Architecture:** Parse a typed run request in the Pi command layer, load one of three fixed project-owned workflows, inject the literal quick brief into the selected workflow before compiling, and bind the choice into preview and frozen resolved config. Extend durable planning with `harness.quick-plan`, which produces and seals the existing spec/plan/tasks/graph contract. Reuse the existing worker/review/verify/integrate pipeline.

**Spec:** `docs/superpowers/specs/2026-09-28-task-kind-workflow-routing-design.md`

**Environment:** Node from `/opt/homebrew/bin` satisfies the repository's Node floor; use `env PATH="/opt/homebrew/bin:$PATH"` for npm/vitest. Baseline `npm test`: 84 files pass, 396 tests pass, 4 skipped in this worktree. A known unrelated Darwin Pi process-token test has flaked in previous runs; report any occurrence and rerun its file once.

## Global constraints

- Preserve `/harness-run <id>` and `.harness/workflow.yaml` semantics and legacy compiled hashes when no kind/brief is supplied.
- A kind is a proposal until the operator approves a preview. Unknown kinds or external workflow paths are rejected. No agent-generated DAG.
- Preview hash must bind kind, brief, selected workflow revision, commands, profiles, and effects; stale approval is rejected.
- Freeze selected workflow and brief in the resolved run config. Resume from that frozen config, even after project presets change.
- Quick plans must produce one validated canonical task with nonempty owned paths and acceptance refs; `bugfix` and `small-feature` retain independent review, per-task verification, post-integration verification, final verification/review, and existing push/PR stages.
- Do not weaken protected-path, task graph, credential, installer, or source lock checks. No new dependencies unless necessary.
- Every behavior change gets a failing test first, then minimum implementation, then green tests and a focused commit.

## File map and interfaces

- `src/pi/commands.ts`, `src/pi/dependencies.ts`, `src/pi/status-view.ts`: typed run request parsing, preview/approval, fixed workflow choice and current status.
- `src/cli/trusted-project-reader.ts`, `src/config/compile.ts`: bounded preset reads and compilation with injected quick brief; keep normal workflow normalization identical.
- `src/config/action-inputs.ts`, `src/ports/planning.ts`, `src/speckit/artifacts.ts`, `src/pi/{planning-agent,child-planning-port}.ts`: quick planning action input, prompt, one-turn artifact contract.
- `src/runtime/production/{planning-action,action-registry,system}.ts`, `src/core/{workflow-engine,workflow-lifecycle}.ts`: durable quick planning, planning lane, graph activation, lifecycle evidence.
- `src/defaults/workflows/{bugfix,small-feature}.yaml`, `src/cli/{init,config-merge}.ts`: opt-in preset files installed by init and validated.
- `docs/workflow-dsl.md`, `README.md`, `docs/installation.md`: selection and override instructions.
- `test/unit/{pi,config,core,speckit}`, `test/integration/{init,pi-native-auth-probe}`, `test/e2e`: behavior evidence. Adapt exact test paths to existing fixture conventions.

## Review focus

1. `/harness-run <id>` produces the exact old workflow revision and no synthetic quick fields.
2. A changed kind or brief after preview cannot reuse an old approval hash.
3. Symlinked, oversized, or arbitrary workflow files cannot be used as quick presets.
4. Quick planning cannot advance to implementation with missing plan/tasks/graph, two tasks, empty paths, missing acceptance refs, or an unsealed graph.
5. A quick run recovers from its frozen selected workflow after project preset edits; no active run can change kind.
6. Both quick workflows retain independent review and every verification/integration gate; bugfix prompt demands reproduction and regression test.

## Task 1 — Parse and freeze a typed run request

**Tests first:** Add parser cases for legacy ID, `--kind bugfix|small-feature|large-feature -- <literal brief>`, missing/unknown kind, empty or over-4096-byte brief, malformed ID in the flagged syntax, unknown flags, and quoted-looking text after `--` staying literal. Verify RED with `env PATH="/opt/homebrew/bin:$PATH" npx vitest run <focused files>`.

**Implement:** Introduce a small `RunRequest`/parser module rather than spreading string handling through `commands.ts`. Keep the old `previewRun(target?)` backend behavior as a compatibility adapter if useful. Preserve the old no-flags parse result and run-ID behavior.

**GREEN:** Focused tests and `npm run typecheck`. Commit `feat: parse and bind task-kind run requests`.

## Task 2 — Load only fixed trusted workflow presets

**Tests first:** New init includes `bugfix.yaml` and `small-feature.yaml` without changing existing files on rerun. Trusted reader rejects symlink, non-file, oversized, or path traversal; older installations still load the legacy large workflow. Selection of a missing quick preset gives a specific repair message. Changed kind/brief yields a different preview hash and stale approval is rejected. Verify RED.

**Implement:** Add exactly two preset assets to `src/cli/init.ts` and compile/validate them in `config-merge.ts`. Read only known paths through bounded regular-file checks. Select `large-feature` from the existing `.harness/workflow.yaml`. For quick workflows, inject the literal brief into the `quick_plan` action input before compile; the preset itself has only the fixed kind. For an explicitly supplied large brief, inject it into `spec-kit.specify`; an unflagged legacy run keeps its existing normalized shape and hash. The quick action schema may allow brief omission at preset-validation time, but preview/run must reject it. Do not allow user input to become a filename. Preview includes kind, brief (or safe summary plus hash), selected revision and effects; approved request selects the workflow written to `writeResolvedRunConfig`. Expose selected kind from frozen run state/config. Never derive it from a mutable global field.

**GREEN:** Focused init/trusted-reader/compiler tests and typecheck. Commit `feat: load validated task-kind workflow presets`.

## Task 3 — One-turn quick planning with the existing artifact seal

**Tests first:** Add `quick` planning contract tests: all spec/plan/tasks files are required and must change, graph is derived and checked, one task only, nonempty owned paths and acceptance refs, correct kind label, and stale/malformed artifacts fail. Add durable receipt/recovery tests so a replayed quick stage does not launch a second planner. Verify RED.

**Implement:** Add `harness.quick-plan` action input `{kind, brief}` for the two quick kinds. Extend `PlanningStage`/request and durable planning action, routed managed planner, prompt builder and planning correlation. Also allow an optional frozen brief in `spec-kit.specify` so the explicit large-feature syntax is meaningful. The quick prompt must explain exact artifact paths and canonical task metadata format; bugfix instructions require reproducer, root cause, failing regression test before fix; small-feature instructions require acceptance criteria and focused test. Use the existing `planningArtifactContract`, `sealTaskGraph`, `ProductionPlanningArtifactSealer`, and `loadRunTaskGraph` path. The quick action commits/seals planning artifacts and yields the graph before fan-out. Map its lifecycle output to `planning.completed`; give it the planning lane. Ensure the embedded Pi and managed child planning modes both receive the same frozen brief.

**GREEN:** Focused tests and typecheck. Commit `feat: add durable quick task planning`.

## Task 4 — Wire three complete workflows and document the choice

**Tests first:** Parse/compile all three templates with shipped profiles. Assert large retains `approve_plan`, quick templates omit it, and every template has implement → independent review → verify → integrate → post-integrate verify → task finalization → final verify/review → push → PR. Add an end-to-end fake-controller quick run through planning, graph activation, review, verification and recovery; assert legacy large run still works. Verify RED.

**Implement:** Create the two quick YAML templates with `quick_plan` and the unchanged common downstream stage IDs. Update production registry/system graph callback, artifact path resolution, status and docs. `/harness-run <id> --kind bugfix -- <brief>` and `small-feature` must preview the selected DAG; no flag remains large. Agent may suggest the kind, operator can rerun with an override before approval. Explain that v1 does not run an automatic LLM classifier and defaults uncertain work to large.

**GREEN:** Focused tests, `env PATH="/opt/homebrew/bin:$PATH" npm run verify`, and `git diff --check`. Commit `feat: route bug fixes and feature sizes through distinct workflows`.

## Completion

- Self-review the complete diff for trust boundary, frozen recovery, duplicate effects, task graph validation, and compatibility with existing initialized projects.
- Run full verification again after any review fix. Report precise passing/failing counts and limitations. Do not push, merge, or create a PR unless the owner asks.
