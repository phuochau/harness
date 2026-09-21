# Phase 6: Production Runtime Completion

**Goal:** Remove the fail-closed development gate only after the installed Pi
extension can create, resume, and finish a durable run through real Spec Kit,
Herdr workers, isolated worktrees, verification, integration, push, and PR.

**Architecture:** Keep the existing durable controller as the only decision
maker. Add one production composition root that binds high-level workflow
effects to immutable run metadata and durable external identities. Pi session
entries are only the planning transport; Herdr is only the worker transport.
Neither becomes a second scheduler. Every production adapter implements fresh
execution plus reconciliation before the Pi backend accepts `/harness-run`.

## Task 35: Persist immutable run metadata and dynamic task graph

- Add a schema-versioned run manifest beside the event journal containing run
  ID, workflow revision, repository identity, frozen base, run ref, artifact
  paths, remote/base branch, and approved preview hash.
- Create the run ref with compare-and-swap semantics and validate the manifest
  on resume.
- Load an empty graph for planning-only stages, then atomically replace it with
  the validated, hash-bound Spec Kit graph after `spec-kit.tasks` completes.
- Add tests for restart, manifest mismatch, graph replacement, and path safety.

## Task 36: Bind production action inputs from durable state

- Add a runtime input binder that derives commits, worktree identities,
  assignments, verification observations, integration candidates, run head,
  push refs, and PR fields from the manifest, journal, and registered
  worktrees—not from worker-provided mutable input.
- Implement composite handlers for `worker.execute`, `worker.review`, planning,
  verification, integration, task projection, final review, push, and PR.
- Persist assignment, Herdr agent, workspace/pane, result, and sealed-change
  records before using them for downstream effects.
- Add crash/reconcile tests at every external-effect boundary.

## Task 37: Connect the Pi planning bridge

- Implement the real `PiPlanningPort` over the current persistent Pi session.
- Persist planning receipts before dispatching Spec Kit slash commands.
- On `agent_settled`, reconcile the correlated transcript, validate artifacts,
  seal the tasks graph, and wake the durable controller.
- Restore the previous model/profile and block ambiguous transcripts.

## Task 38: Compose the resident controller and standalone recovery

- Replace `sessionController` with the production composition root and a fenced
  per-run lease.
- Make `/harness-run` create a run only after approval, then return while the
  resident controller continues asynchronously.
- Route Pi/Herdr/timer/operator events into the same durable queue.
- Make status/graph/log commands read live durable state.
- Reuse the exact action registry for standalone `harness recover`, with
  scheduling disabled.

## Task 39: Prove the real end-to-end release gate

- Add a disposable fixture repository and a real E2E driver owned by this repo;
  do not accept an arbitrary external command as proof.
- Run at least two independent tasks in parallel and one dependent task.
- Exercise Devin, Codex, and Claude across implementation/review smoke runs,
  with Superpowers evidence and distinct reviewer enforcement.
- Verify final task states, immutable commits, test evidence, push, and one PR.
- Run crash/resume and multi-day detach simulation, then full verification and
  an independent final code review.
- Only then remove the development warning and mark the goal complete.

