# TDD Rules

Production implementation is test-first by default.

Use red-green-refactor for production code that adds behavior, changes
behavior, fixes a bug, refactors behavior-preserving code, changes data or API
contracts, or changes configuration that affects runtime behavior.

This file intentionally reads differently from short gate-only rule files. TDD
is both a rule and an execution cycle: it decides when test-first work is
required, how the cycle runs, when exceptions are allowed, and what reviewers
and verifiers must check. It is still a rule file, not a flow recipe. Choose the
flow in `harness/HOW_TO_USE.md`; use this file when that flow touches production
implementation.

## Required Cycle

1. Write the smallest automated proof for the next behavior.
2. Run it and confirm it fails for the expected reason.
3. Write the smallest production change that makes it pass.
4. Run it again and confirm it passes.
5. Refactor only while the proof stays green.
6. Repeat for the next behavior.

If the proof passes before production code changes, it is not proving the new
behavior. Adjust the proof before implementing.

## Planning Rule

Production implementation tasks must list TDD pairs unless an exception is
recorded.

A TDD pair names:

- The failing proof to add or update.
- The production behavior it drives.
- The command or check used for red and green verification.

## Exceptions

TDD is not required for:

- Docs-only changes.
- Research tasks.
- Experiment or throwaway proof-of-concept code.
- Generated code that should not be hand-edited.
- Pure markup, copy, or layout changes with no behavior or state.
- Pure configuration changes that do not affect runtime behavior.

An exception must be recorded in the task, review, verification, or trace with
the reason and the replacement proof, if any.

## UI And Manual Surfaces

For UI with non-trivial behavior, test the behavior first where practical. For
pure layout or visual polish, use the relevant visual, accessibility, or manual
QA proof instead of forcing low-value unit tests.

## Legacy Or Untestable Surfaces

When existing code has no test harness or the behavior cannot be automated
reasonably, add the closest useful characterization, regression, integration, or
manual proof before changing production code. If no proof can be collected,
record the blocked proof and risk before continuing.

## Review Rule

Review must check that production implementation either:

- Followed the TDD pairs and includes red and green evidence, or
- Records an explicit exception with acceptable replacement proof.
