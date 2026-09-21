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
harness recover F023 .
```

`status`, `graph`, and `explain` validate and read only. `recover` does not run
the scheduler. It repairs only an incomplete final JSONL record after copying a
diagnostic; interior corruption or a broken hash chain is fatal. It drains
accepted commands through their durable decision boundary, reconciles every
unobserved effect by external identity, records observations/failures, and then
writes an atomic snapshot.

An indeterminate non-retryable effect is a blocker. Examples include a command
without a probe, ambiguous prompt delivery without a matching structured
result, or a push whose remote identity cannot be proven. Do not delete the
journal or manually mark the job done. Inspect the external state, preserve the
evidence, then retry recovery or resolve the blocker explicitly.

A recovery lease is taken over automatically only when its owner has the
harness recovery PID identity, that PID is provably dead, and the lease is old
enough. Unknown or live owners are never evicted. Fencing rejects writes from a
stale controller even if it retained an old in-memory handle.
