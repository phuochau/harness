# Recovery and operations

Run state lives under the Git common directory:

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

The JSONL journal is append-only and hash-chained. Every mutation requires the
current lock-directory lease and fencing token. A linked worktree resolves to
the same Git common directory, preventing two controllers from silently owning
different copies of one run.

```bash
harness status F023 .
harness graph F023 .
harness explain F023 implement:T001 .
```

`status`, `graph`, and `explain` validate and read only. `harness recover` takes
the fenced recovery lease, loads the same production action registry as the Pi
controller, and reconciles outstanding effects without making new scheduling
decisions. It drains already-accepted commands through their durable decision
boundary, materializes lifecycle evidence for recovered outputs, and writes an
atomic snapshot. Recovery repairs only an incomplete final JSONL record after
copying a diagnostic; interior corruption or a broken hash chain is fatal.

When Pi opens the project again, the extension also selects the newest
unfinished run with the same workflow revision, reacquires its lease, rebuilds
the dynamic task graph from the sealed run ref, and resumes reconciliation.

`/harness-cancel T001` is also durable. The controller records the cancellation,
stops the exact Herdr agent identified by the persisted attempt, and closes its
worker/source workspaces. Read-only review worktrees are removed. A writable
implementation with incomplete changes is switched to a deterministic
`harness/quarantine/...` branch and retained, while the task branch is restored
to its assigned base so an explicit retry can start in a new worktree without
discarding the cancelled worker's partial changes.

An indeterminate non-retryable effect is a blocker. Examples include a command
without a probe, ambiguous prompt delivery without a matching structured
result, or a push whose remote identity cannot be proven. Do not delete the
journal or manually mark the job done. Inspect the external state, preserve the
evidence, then retry recovery or resolve the blocker explicitly.

A recovery lease is taken over automatically only when its owner has the
harness recovery PID identity, that PID is provably dead, and the lease is old
enough. Unknown or live owners are never evicted. Fencing rejects writes from a
stale controller even if it retained an old in-memory handle.
