# Recovery and operations

Run state lives under the Git common directory so every linked worktree sees
one durable identity:

```text
<git-common-dir>/harness/runs/<run-id>/
  events.jsonl
  state.json
  lease.json
  controller.lock/
  assignments/
  evidence/
  logs/
```

The journal is append-only and hash-chained. Every mutation requires the
current fencing token. A stale controller cannot write after another process
takes a provably abandoned lease.

```bash
harness status F023 .
harness graph F023 .
harness explain F023 implement:T001 .
harness recover F023 .
```

The first three commands validate and read only. `recover` acquires the fenced
lease, replays accepted commands, and reconciles external effects through the
same production adapters used by the resident Pi controller. It does not invent
new scheduling decisions.

## Pi child attempts

Each attempt persists `session.json`, `process.json`, and append-only
`events.jsonl` before it is released. Identity includes PID, process start
identity, executable, attempt token, session ID, and argv hash. PID reuse or a
mismatched executable/token is rejected before observation or cancellation.

The child owns its event-file descriptor instead of a pipe owned by the
controller. If Pi's controller process crashes, a running Codex or Devin child
can continue. On restart:

- a matching live process is reattached without a second launch;
- a missing process with a complete `agent_settled` terminal boundary is
  collected from durable evidence;
- an interrupted Devin ACP session is retried as a new attempt because native
  session continuity cannot be proven;
- missing or ambiguous terminal evidence is never treated as success.

Provider stderr is suppressed in detached attempts so an unredacted credential
cannot be left in a crash-surviving log. Structured Pi events and result files
are the durable diagnostics.

## Cancellation and blockers

Cancellation records intent first, verifies exact process identity before each
signal, then performs worktree cleanup. Read-only review worktrees are removed.
Incomplete writable work is retained on a deterministic quarantine branch; the
task branch is restored to its assigned base before an explicit retry.

Do not delete the journal or manually mark work done when recovery reports an
indeterminate effect. Inspect the referenced event/process/result evidence,
resolve the external ambiguity, then run recovery again or explicitly reroute
the task.

Recovery repairs only an incomplete final JSONL record after preserving a
diagnostic copy. Interior corruption or a broken hash chain is fatal.
