# Workflow Package Review

This file records the alignment review for the portable workflow package.

## Review Standard

The workflow package is clean when:

- The workflow is file-based and agent-neutral.
- The docs explicitly learn from Spec Kit, Superpowers, and repository-harness.
- Each standard flow has clear purpose, steps, rules, and required artifacts.
- Templates support ambiguity marking, risk lanes, proof, review, and trace.
- Experiments have clear artifact, storage, proof, result, and production
  boundary rules.
- No document requires a specific CLI, database, or agent runtime.
- No placeholder markers remain in the authored docs.

## Review Loop 1

Findings:

- The first version mentioned the influences but did not make the translation
  explicit enough for future agents.
- Templates needed stronger Spec Kit-style structure: scenarios, acceptance
  tests, ambiguity markers, and parallelizable task metadata.
- The lifecycle needed a clearer pre-execution artifact analysis gate.
- The workflow needed a durable review record.

Actions:

- Added `harness/influence-map.md`.
- Added clarification-marker rules.
- Strengthened request, brief, task, review, verification, and trace templates.
- Added this review file.

## Review Loop 2

Findings:

- No banned placeholder markers were found.
- All Markdown files have a top-level heading.
- The workflow now explicitly maps lessons from Spec Kit, Superpowers, and
  repository-harness.
- Core lifecycle docs, README, and feature flow include the artifact-analysis
  gate.
- Templates now include ambiguity markers, traceability, parallel-safety
  metadata, risk/proof checks, and blocked-proof details.

Actions:

- No further content changes required by this review loop.

## Review Loop 3

Findings:

- User feedback showed the package still looked like documentation, not an
  agent workflow kit.
- Agents, skills, and workflow rules needed first-class folders.
- Scenario flows should be usage guidance, not standalone flow definition
  files.

Actions:

- Added `harness/agents/` with role prompts.
- Added `harness/skills/` with reusable workflow procedures.
- Added `harness/rules/` with enforceable rule files.
- Added `harness/HOW_TO_USE.md` and moved scenario guidance there.
- Moved scenario guidance out of standalone flow files and into
  `harness/HOW_TO_USE.md`.

## Review Loop 4

Findings:

- The package needed a help/orchestration role for moments when the next step,
  owner, lane, proof, or escalation path is unclear.

Actions:

- Added `harness/agents/orchestrator-agent.md`.
- Added `harness/skills/next-step.md`.
- Added `harness/rules/orchestration-rules.md`.
- Updated entrypoints so agents ask the Orchestrator instead of guessing.

## Review Loop 5

Findings:

- The summary lifecycle placed Artifact Analysis before Task Graph, but the
  analysis checks task coverage and therefore must run after task planning.
- The installed layout in file contracts still mentioned the older
  workflow-only structure before this loop.

Actions:

- Reordered lifecycle summaries to run Task Graph before Artifact Analysis.
- Updated file contracts to show `harness/agents/`, `harness/skills/`, and `harness/rules/` as
  first-class installed folders.

## Review Loop 6

Findings:

- `INSTALL.md` needed concrete installation guidance for at least Codex and
  Claude, not just generic adapter notes.

Actions:

- Added a Codex install section with minimum files, recommended `AGENTS.md`,
  optional `.agents/skills/*` adapters, and an example adapter body.
- Added a Claude install section with minimum files, recommended `CLAUDE.md`,
  optional `.claude/commands/*` adapters, and an example command body.

## Review Loop 7

Findings:

- `harness/HOW_TO_USE.md` implied the example flows were the full set instead of a
  starting set.
- Entry points repeated the six examples as if no other flows existed.

Actions:

- Reworked `harness/HOW_TO_USE.md` into flow families, a clean approach, and common
  recipes.
- Updated README, AGENTS, and INSTALL to describe examples as composable
  recipes rather than the complete workflow universe.

## Review Loop 8

Findings:

- `harness/HOW_TO_USE.md` included Orchestrator routing in the standard loop, but the
  canonical lifecycle did not.

Actions:

- Added optional Orchestrator routing to README and lifecycle.
- Renumbered lifecycle sections after the new routing step.

## Review Loop 9

Findings:

- Artifact vocabulary was inconsistent in a few places: `planner` vs
  `delivery-planner`, display labels for review decisions, and `in_progress`
  instead of `in_progress`.

Actions:

- Added owner, review decision, and verification result value lists to
  `harness/file-contracts.md`.
- Normalized delivery brief owner to `delivery-planner`.
- Normalized review decisions and verification results across templates,
  skills, agents, and usage docs.

## Review Loop 10

Findings:

- The workflow package moved from a nested workflow folder inside another
  project to its own repository.
- Several entrypoint and role documents still pointed agents at stale
  nested-folder paths.
- Installation guidance still described mapping from the old source folder.

Actions:

- Updated source-repository references to use root-relative paths.
- Updated the README folder shape to show the standalone repository layout.
- Updated install mapping so target projects copy from this repository into
  their chosen workflow location.
- Verified with a Markdown search for the old path prefix that no stale path
  references remain.

## Review Loop 11

Findings:

- Review of all Markdown documents found a few remaining alignment gaps after
  the standalone-repository move.
- Clarification-marker guidance was not consistently using the exact
  `NEEDS CLARIFICATION: specific question` form.
- Verification guidance used prose values in a few places instead of the file
  contract enums.
- The artifact-analysis skill, template, and delivery-planner stop conditions
  lagged behind the full rule checklist.
- Install guidance could be read as if the target `docs/workflow/` layout
  already existed in this source repository.

Actions:

- Normalized clarification-marker guidance across entrypoints, principles,
  request templates, lifecycle docs, and rules.
- Normalized verification result wording to `passed`, `failed`, `blocked`,
  `not_applicable`, and `risk_accepted`.
- Brought artifact-analysis skill, lifecycle, delivery-brief template, and
  Delivery Planner Agent stop conditions into alignment with
  `harness/rules/artifact-analysis.md`.
- Clarified installation guidance to say the target project should create the
  recommended layout.
- Verified no stale source-path wording, placeholder markers, missing top-level
  Markdown headings, or whitespace errors remain in the reviewed documents.

## Review Loop 12

Findings:

- User feedback clarified that research and experiment are different workflow
  concepts.
- The existing `Spike/research` flow supported investigation, but the workflow
  did not make proof-of-concept experiments first-class.
- The package did not define a default experiment storage location, experiment
  result values, production-boundary rule, or reusable experiment template.

Actions:

- Added an `Experiment / proof of concept` flow for proving a specific proposed
  solution before production implementation.
- Added `experiment` as a task type and `EXP` as an artifact prefix.
- Added `docs/delivery/templates/experiment.md` and a tracked `experiments/README.md`.
- Documented that experiment code defaults to `experiments/` unless overridden
  by the user, brief, or task.
- Documented that production code must not import from `experiments/`, and that
  promotion into product code must pass through normal implementation, review,
  verification, and trace.
- Aligned lifecycle, file contracts, proof gates, artifact analysis, review,
  verification, trace, install guidance, and role docs with the new experiment
  workflow.

## Review Loop 13

Findings:

- Full-document review after adding experiments found several follow-on
  alignment gaps.
- Lifecycle artifact analysis did not include the experiment-specific readiness
  check.
- Intake did not list research or experiment as work types.
- QA guidance still omitted `not_applicable` from verification result values.
- Experiment artifacts were introduced, but installation and folder docs needed
  clearer separation between experiment records and experiment code.
- The experiment template defaulted to `done` even though the recipe creates
  the artifact before proof is collected.

Actions:

- Added the experiment readiness check to lifecycle artifact analysis.
- Added research and experiment to Intake Agent work-type classification.
- Normalized QA result wording to include `not_applicable`.
- Added experiment artifact guidance for `docs/delivery/experiments/`.
- Changed the experiment template default status to `ready`.
- Aligned handoff, builder, planner, reviewer, task, README, install, and
  experiment-folder docs with the experiment workflow.

## Review Loop 14

Findings:

- The workflow required proof before completion, but did not make TDD the
  default for production implementation.
- Task planning did not have a standard place to name test/implementation
  pairs.
- Builder, reviewer, verifier, handoff, and trace docs could record proof
  without recording whether production code was test-first or had an exception.
- Experiments needed to stay separate from production TDD so proof-of-concept
  code remains lightweight and bounded.

Actions:

- Added `harness/rules/tdd-rules.md` as the source of truth for test-first production
  implementation, exceptions, UI/manual surfaces, and legacy or untestable
  surfaces.
- Updated planning, artifact analysis, task, builder, reviewer, verifier,
  handoff, verification, and trace docs to reference TDD pairs or recorded
  exceptions.
- Updated README, INSTALL, AGENTS, lifecycle, principles, file contracts, and
  adapters so copied workflows include the TDD rule.
- Kept experiment code exempt from strict production TDD while still requiring
  experiment proof and production-boundary review.

## Review Loop 15

Findings:

- A full-document review after adding the TDD rule found lifecycle summaries
  that still described plain build work instead of build-under-TDD work.
- The Verifier Agent recorded TDD evidence but did not list `harness/rules/tdd-rules.md`
  as an input.
- The Historian Agent recorded proof gaps but did not explicitly preserve TDD
  evidence or exceptions in trace.

Actions:

- Updated README and lifecycle summaries to say build work runs under TDD.
- Added `harness/rules/tdd-rules.md` to Verifier and Historian inputs.
- Updated Historian procedure to record TDD evidence or exceptions for
  production implementation.

## Review Loop 16

Findings:

- User feedback showed agents could still miss the relationship between roles,
  skills, and rules.
- `harness/`, `harness/rules/`, and `harness/adapters/` were defined in separate places, but
  the entrypoints did not provide one concise ownership map.
- The flow recipes in `harness/HOW_TO_USE.md` named primary skills, while risk-lane
  rules defined required artifact weight; without a bridge, rules could look
  like competing workflows.
- `harness/rules/tdd-rules.md` intentionally included a cycle, but did not explain why
  it was more procedural than the shorter rule files.

Actions:

- Added building-block boundaries and a role/skill/rule map to
  `harness/HOW_TO_USE.md`.
- Added folder responsibility guidance to `harness/README.md` and `AGENTS.md`.
- Updated `INSTALL.md` sample agent instructions and first-use checklist to
  point target projects at the same role/skill/rule map.
- Updated the Orchestrator Agent and next-step skill so routing returns the
  rule files to apply, not only the role and skill.
- Clarified that flow recipes name common paths while risk lanes decide the
  required process weight.
- Clarified that adapters are optional runtime glue and cannot override local
  workflow files.
- Clarified that `harness/rules/tdd-rules.md` is both a gate and execution cycle, not a
  competing flow recipe.
- Recorded the docs-only TDD exception here; replacement proof is Markdown
  consistency checks and targeted searches for stale or contradictory wording.

Proof:

- `git diff --check` passed with no whitespace errors.
- `rg -n 'TO[D]O|TB[D]|FIX[M]E' .` found no active placeholder markers.
- Top-level-heading check over root, agent, skill, rule, workflow, adapter,
  template, and experiment Markdown files found no missing `#` heading.
- Targeted searches confirmed new guidance exists for folder responsibilities,
  building-block boundaries, the role/skill/rule map, adapter ownership, and
  the TDD rule's procedural shape.
- Targeted searches confirmed Orchestrator and next-step routing now include
  rule files to apply.

## Review Loop 17

Findings:

- User requested a CLI script or equivalent path for installing the workflow
  into a Claude project.
- `INSTALL.md` documented manual Claude installation but did not provide an
  executable install path.
- The package claimed no CLI was required, which remains true, but it did not
  distinguish optional automation from source-of-truth workflow files.

Actions:

- Added `scripts/install-claude-workflow.sh`.
- Added `tests/install_claude_workflow_test.sh`.
- Updated `INSTALL.md` with Claude CLI usage, `--force`, `--dry-run`, and
  `--no-commands` examples.
- Updated the README folder shape to include `scripts/` and `tests/`.

TDD evidence:

- Red: `sh tests/install_claude_workflow_test.sh` failed because
  `scripts/install-claude-workflow.sh` did not exist.
- Green: after adding the installer, `sh tests/install_claude_workflow_test.sh`
  passed.

Proof:

- The test verifies generated `CLAUDE.md`, `AGENTS.md`, `harness/`,
  `docs/delivery/templates/`, `docs/delivery/experiments/`,
  `experiments/README.md`, and `.claude/commands/`.
- The test verifies overwrite protection, `--force`, `--dry-run`,
  `--no-commands`, and installing into a nested target path.

## Review Loop 18

Findings:

- User feedback clarified that Claude projects should receive a top-level
  `harness/` folder instead of burying the workflow package under
  `docs/workflow/`.
- The installer, generated Claude instructions, command adapters, install docs,
  adapter examples, and file-contract layout all still pointed at
  `docs/workflow/`.

Actions:

- Updated the installer to copy workflow files into `harness/`.
- Updated generated `CLAUDE.md`, generated `AGENTS.md`, and generated
  `.claude/commands/*` adapters to read from `harness/`.
- Updated `INSTALL.md`, `harness/adapters/agent-adapters.md`,
  `harness/file-contracts.md`, and README install wording to use `harness/`.
- Updated the installer test to require `harness/` and reject a fresh
  `docs/workflow/` install.

TDD evidence:

- Red: after changing the test expectation to `harness/`, `sh
  tests/install_claude_workflow_test.sh` failed because
  `harness/README.md` was missing.
- Green: after updating the installer and docs, `sh
  tests/install_claude_workflow_test.sh` passed.

## Review Loop 19

Findings:

- The installers relocated files (workflow files flattened into `harness/`,
  templates into `docs/delivery/templates/`), but the copied docs still used
  source-layout paths such as `workflow/lifecycle.md` and `templates/task.md`.
  Every such reference was a dead link in installed projects, and the tests
  only checked file existence so the breakage shipped green.
- Path references were split across two frames: some docs used bare
  source-relative paths while others already used `harness/`-prefixed paths.
- The two installers were ~90% duplicated shell.
- Claude commands and Codex skills covered different role subsets.
- The 400-line internal `REVIEW.md` changelog was copied into every installed
  project.
- No LICENSE, `.gitignore`, or CI existed; one test file was not executable;
  `--force` copies deleted the destination before writing.

Actions:

- Unified the source layout to match the installed layout (single
  `harness/`-prefixed frame; templates under `docs/delivery/templates/`) and
  rewrote every intra-package reference accordingly.
- Added `tests/link_check_test.sh`, which installs with each installer and
  asserts every inline Markdown reference resolves from the target root.
- Extracted `scripts/install-common.sh`; the two installers are now thin
  wrappers. Copies are atomic (temp sibling then `mv`).
- Gave both runtimes the same canonical adapter set (intake, next-step,
  plan-delivery, build, review, verify, trace) from one definition.
- Excluded `harness/REVIEW.md` from installed projects; the installer now also
  creates the `docs/delivery/` output directories.
- Added `LICENSE`, `.gitignore`, and a GitHub Actions workflow that runs
  shellcheck and all three test scripts; fixed test executable bits.

Proof:

- Red: `sh tests/link_check_test.sh` reported dozens of broken references
  against the previous installers.
- Green: after the layout unification and installer rewrite, all of
  `tests/install_claude_workflow_test.sh`,
  `tests/install_codex_workflow_test.sh`, and `tests/link_check_test.sh` pass.
- `shellcheck -S warning scripts/*.sh tests/*.sh` is clean.
- `git diff --check` reports no whitespace errors.
