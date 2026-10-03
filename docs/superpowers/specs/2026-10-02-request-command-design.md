# Request command design

## Goal

A person describes work once with `/harness:req <description>`. The harness decides whether to continue a normal conversation, propose a workflow run, or invoke an existing operational command. All direct Pi commands use `/harness:<command>`; the former hyphenated commands are removed.

## Behavior

- The extension classifies the literal description with the current Pi model into `discuss`, `run`, or a known operational command. The classifier is one model call, not another agent or controller workflow. The response is validated against a closed schema. Invalid output, unavailable models, and uncertain intent continue as a normal conversation.
- `discuss` passes the original description back into the ordinary Pi conversation. It does not create a run, change repository state, or promise that a run started.
- `run` chooses one of `bugfix`, `small-feature`, or `large-feature`. The extension generates the run ID through the existing controller path, compiles the selected project workflow, shows the kind, reason, brief, checks, workers, and effects, and requires the existing explicit approval before enqueueing a run. Classification never directly schedules work.
- Read-only operational requests (`status`, `graph`, `task`, `logs`, `doctor`) may execute immediately when their target is unambiguous. Mutating operational requests (`retry`, `reroute`, `cancel`, `pause`, `resume`) require a separate confirmation showing the operation and target. Missing or ambiguous targets continue as a normal conversation.
- Direct commands remain available as `/harness:run`, `/harness:status`, `/harness:graph`, `/harness:task`, `/harness:logs`, `/harness:retry`, `/harness:reroute`, `/harness:cancel`, `/harness:pause`, `/harness:resume`, and `/harness:doctor`. No old command names are registered.

## Boundaries

The classifier cannot choose a workflow path, shell command, model profile, credential, or repository path. User text is data, not executable instruction. A classifier answer is a suggestion checked by the extension and frozen into the existing preview hash. Explicit direct `/harness:run` syntax remains available for operators.

## Verification

Unit tests cover literal descriptions, classifier failures, uncertain requests, each command route, confirmation boundaries, and no legacy registration. A Pi loader test proves colon commands appear. Run typecheck, build, and repository tests; then launch Pi from the local checkout in `growth-engine-hub` and confirm `/harness:req` appears.
