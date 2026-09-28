# Task-Kind Workflow Routing — Design

**Date:** 2026-09-28
**Status:** Approved by the owner in conversation for brainstorming and implementation with Devin CLI SWE-2 Max.

## Intent and decision

The owner wants a bug fix, a small feature, and a large feature to follow different engineering workflows. A coding agent may propose a kind, but it must not invent or silently mutate the controller's DAG. The operator can override the proposal before run approval. The default for an unclassified legacy `/harness-run <id>` remains the existing large-feature workflow.

Three approaches were considered: manually copying presets (simple but no run-level choice), letting an agent generate a workflow (flexible but unverifiable), and selecting a validated, frozen workflow at run preview. We use the third. Classification is an explicit suggestion in the run command, not an automatic LLM call in v1. This avoids an unbounded classifier dependency and makes the decision inspectable. An agent can recommend a kind in conversation or issue the command with `--kind`; the operator sees the selected kind, brief, stages, and effects in the approval preview and can rerun with another kind before confirming.

## Run intake and routing

Support three exact kind IDs: `bugfix`, `small-feature`, `large-feature`. Add `/harness-run <run-id> --kind <kind> -- <brief>`; the text after `--` is a literal task brief and is required for the two quick kinds. A large-feature brief is optional and, when supplied, becomes the frozen instruction to its `specify` stage. Keep `/harness-run <run-id>` compatible and map it to `large-feature` without adding new fields to the compiled workflow. For the new flagged syntax, reject unknown flags, malformed IDs, empty or over-4096-byte briefs, and attempts to smuggle a workflow path. Do not parse the brief as shell or YAML. A small parser produces a typed run request. A run preview binds the request, chosen workflow revision, profiles, commands, and effects into the approval hash. A changed kind or brief invalidates earlier approval. The resolved run configuration freezes the selected workflow and brief for recovery; the run status exposes the selected kind. No active run can be reclassified.

The selector reads only the three fixed project-owned workflow paths: `.harness/workflow.yaml` for `large-feature`, `.harness/workflows/bugfix.yaml`, and `.harness/workflows/small-feature.yaml`. The same bounded regular-file, no-symlink trusted reader applies to all paths. The controller validates and compiles the chosen document with current profiles and commands before preview. Missing quick presets in an older initialized project produce a clear repair message; its legacy large workflow still runs. The agent's kind suggestion does not grant permissions or bypass protected-path policy.

## Workflow shapes

All three use the existing task graph, worktree isolation, independent review, task verification, integration, post-integration verification, final verification, final review, push, and PR stages. This retains controller-owned `DONE` and recovery behavior. The large workflow is byte-for-byte the shipped default: `specify → plan → approve_plan → tasks`, then the common execution pipeline.

The `bugfix` and `small-feature` templates replace those four planning stages with one `quick_plan` stage using `harness.quick-plan`. They require a nonempty brief and produce the same four paths (`spec`, `plan`, `tasks`, `graph`) expected by the existing runtime. Quick planning is a single planner turn, with no separate plan approval; run preview approval still applies. A bugfix prompt requires reproduction, likely cause, a failing regression test before the fix, and a narrow change. A small-feature prompt requires explicit acceptance criteria, scope, and a focused test. Both require one canonical task, owned paths, at least one acceptance reference, and a non-parallel task graph. The artifact validator seals the graph and planning commit with the same integrity checks as the large workflow. A quick plan that omits or contradicts these artifacts fails before implementation.

## Safety and operational behavior

The selected workflow and brief are data in the hashed resolved workflow; neither workers nor a later project edit can switch a running job to another DAG. The controller validates stage/profile roles, task graph, independent review, and exact test commands as it does today. The quick stage uses the same durable planning receipt and sealer, with a distinct action and planning lane. Retries and recovery reuse the frozen brief and artifact hashes. No new provider, scheduler, shell execution, or credential path is introduced.

The prompt text is task data; it cannot add a new action kind or disable a gate. Quick plans use the planner profile already declared for the stage. Uncertain scope should be proposed as `large-feature`. No per-task mixed workflow selection within one large run is included; the large workflow still decomposes a feature into independently scheduled tasks.

## Verification and documentation

Tests cover parser ambiguity, overrides and preview-hash binding, trusted preset loading, legacy default behavior, quick artifact acceptance/rejection, graph activation and recovery, template structure, and an end-to-end fake-controller quick run through review and verification. Documentation explains when to choose each kind, command syntax, the agent's advisory role, and the remaining limitation that real provider quality is not established by tests. Existing default workflow hashes and initialized projects remain compatible.
