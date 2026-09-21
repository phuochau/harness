# Release Evidence

This audit binds the Pi-native Codex CLI + Devin CLI release criteria to
executable evidence. Provider-specific authentication remains local and no
credential value is stored here.

| Criterion | Authoritative evidence |
|---|---|
| 1. Runnable workflow on init | `test/integration/init.test.ts` validates the complete editable DSL, Devin-first implementation fallback, profiles, environment, lock, and Pi settings. |
| 2. Approved isolated setup | `test/integration/bootstrap.test.ts` and `test/integration/install/**` prove plan-hash approval, exact sources/integrities, managed package roots, receipts, and fail-closed behavior. |
| 3. Doctor readiness | `test/integration/doctor.test.ts` proves the Node floor, locked capability health, authentication diagnostics, and redaction. |
| 4. Spec Kit planning via Codex | `test/integration/speckit/**` proves correlated and sealed artifacts; `test/e2e/pi-native-real.test.ts` creates both specification and plan artifacts through Pi + Codex CLI. |
| 5. Editable provider routing | `test/unit/core/routing.test.ts`, `test/unit/config/profiles.test.ts`, and `test/contract/pi-worker-runtime.test.ts` exercise profile-selected roles over the common Pi runtime. Defaults require only Codex CLI and Devin CLI. |
| 6. Dependency-safe parallel worktrees | `test/unit/core/workflow-engine.test.ts`, `test/unit/core/policy.test.ts`, `test/integration/git/worktrees.test.ts`, and `test/e2e/fake-controller.test.ts` prove READY gating, concurrency rules, and distinct worktrees. |
| 7. Controller-owned DONE | `test/unit/core/workflow-lifecycle.test.ts`, `test/e2e/production-pipeline.test.ts`, and the default workflow require independent review, verification, integration, post-integration verification, and task projection. |
| 8. Durable crash/recovery | `test/e2e/crash-matrix.test.ts`, `test/e2e/race-matrix.test.ts`, `test/integration/pi-process/controller-crash.test.ts`, `test/integration/pi-process/runtime.test.ts`, and `test/integration/recover-cli.test.ts` cover fenced recovery, detached monitor ownership and cancellation, controller-bound receipt trust roots, signed provider/exit receipts, orphan and descendant process-group termination, launch-intent replay, exact live process identity/token, frozen package/transport/supervisor identity, frozen run configuration, and profile-backed CLI recovery. The real E2E recreates the runtime and accepts the completed Devin attempt from durable process/session evidence. |
| 9. Closed worker context | `test/integration/pi-worker/profiles.test.ts`, `test/unit/runtime/managed-environment.test.ts`, and `test/unit/runtime/pi-launch-spec.test.ts` prove discovery is disabled and only declared resources/tools/environment keys are projected. Credentials require explicit auth or `--reuse-local`. |
| 10. Real disposable E2E | `npm run e2e:real` passed on 2026-09-21 in 200.38s: packed install, Codex Spec Kit specification/plan, Devin worktree implementation, controller-bound signed process receipts, runtime restart recovery, detached Codex review, exact fast-forward integration, and final tests. Full controller scheduling and crash matrices are covered deterministically by the non-subscription production E2E suite. |

## Release gates

| Gate | Result |
|---|---|
| `npm run verify` | Passed: 78 test files passed, 1 conditional file skipped; 347 tests passed, 4 opt-in/fixture tests skipped; clean package dry-run. |
| `npm run e2e:real` | Passed: 1 authenticated E2E test in 200.38s. |
| Package contents | `test/integration/packed-package.test.ts` installs the tarball and loads both public entrypoints; it rejects tests, journals, `.harness-output`, source maps, and removed-runtime artifacts. |
| Removed second execution plane | Active production source, defaults, scripts, tests, package metadata, and release workflows contain no dependency on a second orchestrator. Historical migration documents retain rationale only. |
| Review | Two independent review passes found and drove fixes for recovery composition, planning receipts, credential projection, process crash windows, real exit status, live token identity, and frozen profile routing. The corrected commit must receive a final no-blocker review before push. |

The exact reviewed and pushed commit plus pull-request URL are recorded in the
pull request and task attachment, because they do not exist until the final
review gate has passed.
