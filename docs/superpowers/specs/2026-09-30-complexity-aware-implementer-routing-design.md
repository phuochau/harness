# Complexity-Aware Implementer Routing — Design

**Date:** 2026-09-30
**Status:** Conversational design approved; written spec awaiting owner review.

## Intent and scope

Route each Spec Kit implementation task to a deliberately configured model profile according to the task's difficulty. Follow the Superpowers subagent-driven-development policy for review-driven fixes: retain the original implementer's conversation for fix rounds 1–3, hand the task to a fresh implementer at least one model tier stronger for rounds 4–5, and stop after round 5 with unresolved findings visible to the operator. The routing choice must be explainable, reproducible after a controller restart, and constrained to profiles the owner has configured and authenticated.

This change applies to `worker.execute` jobs for individual tasks. Planning, task review, final review, verification, integration, push, and pull-request stages keep their current model selection and gates. The feature does not infer model quality from provider names or scan every provider's catalog for a supposedly best model. Profile availability is established through the existing exact provider/model and authentication preflight.

## Terms and invariants

- **Complexity** is a planner assessment of the implementation task: `mechanical`, `standard`, or `complex`, ordered in that sequence. It is not a property of a model.
- **Tier** is an owner-declared routing group with the same ordered names. A profile can appear in only one tier within a routing policy. Tier membership expresses the owner's judgment of that profile's capability for this workflow; model names and prices do not imply a tier.
- **Attempt** is an execution of a harness job. Infrastructure retry attempts and review-driven fix rounds have separate counts.
- **Fix round** counts review-driven fix implementations that have been dispatched for a task. The first implementation has fix round 0; the next implementation after an accepted `changes_requested` review is fix round 1. A failed launch, unavailable profile, malformed result, timeout, cancelled run, or failed verification does not increment the fix round. A `changes_requested` review after fix round 5 records pending findings but does not create round 6.
- A completed implementation, its review, and any fix belong to the same task branch. Each worker assignment retains the existing commit, owned-path, evidence, and worktree validation.
- A route is chosen from the frozen workflow and task assessment. No credential, catalog, or user-global Pi configuration is copied into the journal.

## Task assessment and artifact versioning

The Spec Kit `tasks` stage must emit a complexity and a brief concrete reason for every implementation task. The assessment uses the task description, owned paths, dependencies, acceptance criteria, and approved plan. Guidance mirrors Superpowers:

| Complexity | Guidance |
| --- | --- |
| `mechanical` | A complete prescription, a small isolated change, usually one or two files, little integration judgment. |
| `standard` | Coordination across files, established patterns to adapt, ordinary debugging or integration decisions. |
| `complex` | Architecture, ambiguous design judgment, broad codebase understanding, or subtle high-risk behavior. |

The planner must name task-specific evidence in the reason; a generic statement such as “this is complex” does not satisfy the planning instruction. The parser enforces a nonempty normalized reason of at most 500 characters. The v2 visible task line inserts ` | complexity=<tier> | why=<canonical JSON string>` immediately before the existing ` | deps=... | ac=... | paths=...` fields. For example, `- [ ] T001 Update parser | complexity=standard | why="Touches parser and CLI contract" | deps=[] | ac=["FR-001"] | paths=["src/parser.ts"]`. The v2 canonical EOF metadata record and task graph node add scalar keys `complexity` and `complexityReason`, and both values must match the visible line. Define `harness/task-metadata/v2` and `harness/task-graph/v2`, including the assessment in the semantic hash and canonical task projection. Parsers reject missing values, unknown tiers, duplicate keys, malformed JSON strings, and disagreement between visible and metadata values.

The existing v1 parser, graph, semantic hash, and sealed runs remain valid. New complexity-routing workflows require v2 task artifacts; a v1 task graph with such a workflow fails at preflight with a migration instruction. Legacy workflows continue to accept v1 and keep their existing route behavior. A run already created from a frozen v1 graph and workflow is never silently upgraded.

## Workflow configuration and profile discovery

Add an opt-in, closed runner form for a task-scoped `worker.execute` stage. Conceptually:

```yaml
runner:
  by_complexity:
    mechanical: [implementer-fast]
    standard: [implementer-standard]
    complex: [implementer-strong]
```

This is the new closed runner form. Its only field is `by_complexity`, containing exactly the three named tiers. Higher-tier fallback and the five-round fix policy are fixed behavior in this feature, not independently tunable workflow keys:

1. Every complexity tier has a nonempty, ordered list of implementation-role profile IDs. IDs must exist in the frozen resolved profiles and be unique across tiers. An ordinary `runner: profile-id` or `runner: { prefer: [...] }` retains existing behavior.
2. On the first implementation, try declared profiles in the task's tier in order. If none is ready, try the next stronger tier, continuing upward. Never silently route to a weaker tier. A missing eligible profile blocks the task with profile-specific diagnostics.
3. Selection uses the existing isolated profile probe: provider registered, exact model ID available, authentication ready, and managed resources verified. It does not probe the endpoint for quality or benchmark performance. An endpoint that fails after preflight follows infrastructure retry policy.
4. Freeze the selected profile ID, actual tier, assessment, and policy revision in the run's durable decision history. A controller restart must replay the same accepted route; later catalog or auth changes may make continuation unavailable but must not silently substitute a different profile. A fresh attempt may choose another declared candidate only through an explicit recorded reroute or the defined escalation transition.
5. An operator `reroute` remains possible only to a profile declared by the implementation stage. It records who/what requested the change and the effective tier. If it changes the profile, the next worker receives a fresh session; it must never append a different model's turns to the old session.

The shipped Codex/Devin workflow and existing `harness/profiles/v1` documents remain valid. Complexity routing is activated only when an owner supplies the new runner form and profiles for the tiers; the feature must not silently enable new providers or credentials. Documentation should show how to list Pi models, configure a profile, authenticate it, and assign that profile to a tier. Catalog discovery aids configuration; only declared profiles are routing candidates.

## Review-driven fix loop

The current `retry.max_attempts: 3` is an execution-retry budget, not a Superpowers fix-round budget. Introduce a separate durable `fixRound` count per task implementation lineage and keep transient or infrastructure retries separate. The new runner form allows five review-driven fix rounds, with rounds 1–3 reusing the initial implementer session and rounds 4–5 using a new session on a profile at least one declared tier above the profile used in rounds 1–3. The numbers are fixed for this first feature.

The implementation and task-review execution retry budgets apply separately within each fix-round generation. A review-driven transition starts a new generation with fresh local execution budgets for both stages; it does not reuse their exhausted `max_attempts` counters. Persist a monotonically increasing global attempt identity for idempotency and a generation-local attempt count for budget enforcement. Existing legacy workflows retain their present attempt-budget semantics.

For each review result with `changes_requested`:

1. Persist the reviewed commit and exact open findings before invalidating the implementation/review path.
2. If the current fix round is below 5, schedule exactly one next fix implementation and increment `fixRound` when that dispatch is durably accepted. Duplicate review observations or controller recovery cannot schedule an additional round. If round 5 has already been reviewed, retain the findings and stop.
3. Provide the next implementer with the task requirements, previous implementation commit, open findings, and a durable report of work and tests tried so far. The controller builds this report from accepted worker results, their verified evidence, and accepted review findings; it does not trust an unverified worker-written summary. The report is task-owned data outside disposable worktrees, limited to 1 MiB and hash-checked; if it cannot be built within the limit, block with a report-size diagnostic instead of silently dropping findings. It supplements the transcript and is the complete handoff at escalation.
4. For rounds 1–3, resume the original Pi transcript with the same profile and a new assignment that identifies the current worktree and commit. The transcript stays in a protected, task-scoped session directory outside `.harness-output`. Pi continuation must be invoked with its documented session-resume path or ID, not by assuming that passing `--session-id` creates a continuation. Do not append to one transcript concurrently.
5. For each of rounds 4 and 5, dispatch a fresh implementer with a new Pi transcript on a profile in a strictly stronger configured tier than the original implementer's actual tier. The new implementer receives the report and all still-open findings. If no stronger, ready, declared profile exists, block with `no_escalation_profile` and preserve the pending findings; do not claim that a same-tier retry is an escalation.
6. Review the new immutable commit through the existing independent-family review gate. Continue until approved or the fifth fix round has been reviewed. At the cap, stop automatic implementation and surface unresolved findings for operator adjudication or an explicit reroute; do not mark the task done.

An initial `complex` task can start in the strongest tier. If it still has open review findings at escalation time and no stronger tier exists, the same `no_escalation_profile` block applies. This is an intentional, visible ceiling, not an automatic fallback to the same model. Explicit operator reroute may choose any profile declared in the implementation stage, including a lower tier, but does not reset `fixRound`; a profile change always starts a fresh transcript and is recorded as an override.

Review and verification retain their current selection and evidence rules. This feature does not add model routing to reviewer jobs or automatically scope reviewer prompts to only the newest diff. A review's `changes_requested` is the only signal that enters the fix loop; `verification_failed` continues through the existing remediation path without consuming fix rounds.

## Session lifecycle and recovery

The current worker runtime generates a new session ID and stores its session under the attempt worktree, which is removed after a completed attempt. The new task-owned session store must therefore be separate from worktree cleanup. Persist a session identity and verified session-file location for the first implementer lineage. Each subsequent fix-round assignment has its own assignment hash and attempt token even when it resumes that transcript. The session store must be confined to the run's managed state root, consist of regular files with private permissions, and be excluded from task commits and owned-path assignments; only the managed Pi process writes the transcript. Existing process and attempt fencing still prevents a stale child from writing an accepted result.

On recovery, the controller must distinguish an active attempt, a completed attempt awaiting journal commitment, an accepted review awaiting fix dispatch, and a session whose continuation file is missing or corrupt. Reconciliation must never launch two writers against one transcript or replay a fix round twice. A missing/corrupt transcript for rounds 1–3 blocks with a specific recovery reason; it does not silently create a new conversation and pretend to have retained context. On rounds 4–5, the durable report permits a fresh-model handoff even though the prior transcript is not reused. Keep session files until the run's normal retention/cleanup boundary; clean them only after no reconciliation can need them.

## Events, status, and operator explanation

Extend durable route evidence to include task ID, assessed complexity and reason, configured candidate profile IDs, selected profile and tier, fix round, route cause (`initial`, `review_fix`, `escalation`, or `operator_reroute`), and the relevant workflow/task hashes. Avoid storing authentication material or full prompts in events. The reducer derives the active implementation lineage and fix-round count only from accepted, idempotent events. `harness status`, `graph`, and `explain` should show the current tier/profile, fix round, pending findings, and a concise reason when routing or escalation blocks. Existing v1 event replay remains supported.

## Failure behavior

- Missing or unauthenticated profiles: try the next declared candidate under the initial-selection rule; otherwise block with evidence. Do not call an undeclared model.
- Provider transport failure, timeout, invalid worker result, or failed verification: use existing retry/remediation rules and preserve the fix-round count. Do not automatically increase the model tier.
- An execution retry within a fix round retains the selected profile and resumes its transcript when that transcript is valid. If it cannot safely resume, block with a session-continuation reason; do not quietly allocate a new model or transcript.
- Review findings: use the fix loop above. A repeated observation of the same review result must not add another round.
- Session continuation failure: block with recoverable diagnostics; leave the branch, report, transcript, and findings available for inspection.
- Exhausted five-round fix loop: stop automatic dispatch; require operator adjudication or explicit reroute before more implementation. The ordinary `DONE` and final-review gates remain unchanged.

## Verification and acceptance

Automated tests must cover v1 compatibility, v2 visible/metadata equality and semantic hashing, closed workflow validation, deterministic initial tier selection, stronger-tier fallback, unavailable profiles, operator reroute, independent reviewer family, and journal replay after restart. Review-driven fixes must prove rounds 1–3 retain the same transcript and profile; round 4 gets a fresh transcript and a stronger profile with the complete handoff; round 5 stops on unresolved findings. Separate tests must prove transport retries and verification failure leave `fixRound` unchanged, duplicate review events do not double-increment it, and a missing transcript blocks instead of resetting context.

Use the pinned real Pi CLI in an integration test to verify that a second process can resume a prior session from the managed store and accept a new assignment from a different attempt worktree. A mocked `--session-id` assertion is insufficient. Test recovery when a controller restarts between review acceptance and fix dispatch, and when an attempt is active at restart. End-to-end claims about specific hosted or local models require those models' real credentials or endpoints; configuration and protocol tests alone establish routing behavior, not model quality.

## Non-goals

No automatic ranking of all provider models, live benchmarking, price feed, user-global Pi configuration import, review-model routing, planning-model routing, changed independent-review policy, or cross-machine session migration is included.
