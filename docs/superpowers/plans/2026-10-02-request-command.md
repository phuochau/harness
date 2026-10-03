# Request command implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Add a single description-first `/harness:req` entrypoint and rename direct Pi commands to the colon namespace.

**Architecture:** A small request router makes one structured model call through the active Pi context, validates the result, and dispatches to the existing command service or ordinary Pi conversation. Existing run preview, approval hash, and controller scheduling remain authoritative.

**Tech Stack:** TypeScript, Pi extension API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-request-command-design.md`

## Global constraints

- Keep model output within a closed set of actions and task kinds.
- Do not enqueue a run or mutating intent without explicit UI confirmation.
- Remove hyphenated Pi command registrations; keep controller operation names unchanged.
- Preserve existing durable run semantics and CLI commands.

## Review focus

- A description with spaces must reach the planner as a brief, never as a run ID.
- Classification failure must continue the normal conversation.
- Missing targets must not trigger operational changes.
- The displayed preview must bind the selected kind and original brief.
- Pi must list only colon-named harness commands.

### Task 1: Request routing

**Files:** `src/pi/request-router.ts`, `test/unit/pi-request-router.test.ts`

- [ ] Add failing tests for valid, invalid, and uncertain classifier output.
- [ ] Implement bounded classification and decision validation.
- [ ] Run the focused test and typecheck.

### Task 2: Command namespace and dispatcher

**Files:** `src/pi/extension.ts`, `src/pi/commands.ts`, `test/unit/pi-commands.test.ts`, `test/integration/pi-loader.test.ts`

- [ ] Add failing tests for `/harness:req`, all colon commands, direct run approval, operational confirmations, and no hyphen aliases.
- [ ] Register and dispatch the new commands through the request router.
- [ ] Run focused tests and typecheck.

### Task 3: Documentation and local installation

**Files:** `README.md`, `docs/workflow-dsl.md`, `docs/installation.md`, `growth-engine-hub/.pi/settings.json` if required.

- [ ] Replace user-facing command examples and document request routing.
- [ ] Run full `npm run verify` and inspect the package contents.
- [ ] Rebuild the local harness checkout and verify `/harness:req` from Pi in `growth-engine-hub`.
