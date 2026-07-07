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

- Added `workflow/influence-map.md`.
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

- Added `agents/` with role prompts.
- Added `skills/` with reusable workflow procedures.
- Added `rules/` with enforceable rule files.
- Added `HOW_TO_USE.md` and moved scenario guidance there.
- Moved scenario guidance out of standalone flow files and into
  `HOW_TO_USE.md`.

## Review Loop 4

Findings:

- The package needed a help/orchestration role for moments when the next step,
  owner, lane, proof, or escalation path is unclear.

Actions:

- Added `agents/orchestrator-agent.md`.
- Added `skills/next-step.md`.
- Added `rules/orchestration-rules.md`.
- Updated entrypoints so agents ask the Orchestrator instead of guessing.

## Review Loop 5

Findings:

- The summary lifecycle placed Artifact Analysis before Task Graph, but the
  analysis checks task coverage and therefore must run after task planning.
- The installed layout in file contracts still mentioned the older
  workflow-only structure before this loop.

Actions:

- Reordered lifecycle summaries to run Task Graph before Artifact Analysis.
- Updated file contracts to show `agents/`, `skills/`, and `rules/` as
  first-class installed folders.

## Review Loop 6

Findings:

- `INSTALL.md` needed concrete installation guidance for at least Codex and
  Claude, not just generic adapter notes.

Actions:

- Added a Codex install section with minimum files, recommended `AGENTS.md`,
  optional `.codex/skills/*` adapters, and an example adapter body.
- Added a Claude install section with minimum files, recommended `CLAUDE.md`,
  optional `.claude/commands/*` adapters, and an example command body.

## Review Loop 7

Findings:

- `HOW_TO_USE.md` implied the example flows were the full set instead of a
  starting set.
- Entry points repeated the six examples as if no other flows existed.

Actions:

- Reworked `HOW_TO_USE.md` into flow families, a clean approach, and common
  recipes.
- Updated README, AGENTS, and INSTALL to describe examples as composable
  recipes rather than the complete workflow universe.

## Review Loop 8

Findings:

- `HOW_TO_USE.md` included Orchestrator routing in the standard loop, but the
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
  `file-contracts.md`.
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
  `rules/artifact-analysis.md`.
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
- Added `templates/experiment.md` and a tracked `experiments/README.md`.
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
