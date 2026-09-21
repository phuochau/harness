---
description: Generate Spec Kit tasks and a deterministic harness task graph
strategy: wrap
---
{CORE_TEMPLATE}

Render every phase heading as `## Phase N: <name>` and every task as exactly:

`- [ ] T001 [P] [US1] Description | deps=[] | ac=["FR-001"] | paths=["src/file.ts"]`

`[P]` and labels are optional; the three pipe fields are required JSON string
arrays. Escape a literal description pipe as `\|`. Then append exactly one EOF
block with no content after it:

<!-- harness-task-metadata:v1
{"schema":"harness/task-metadata/v1","tasks":[{"acceptanceRefs":["FR-001"],"dependsOn":[],"description":"Description","id":"T001","labels":["US1"],"ownedPaths":["src/file.ts"],"parallelEligible":true,"phase":"<name>"}]}
-->

Include one metadata record per visible task in visible order and copy every
field from the visible entry after normalization. Emit the JSON line as
canonical JSON: object keys sorted by locale-independent UTF-16 code-unit order,
no insignificant whitespace, and already-normalized arrays. Do not write
`task-graph.json` and do not compute a hash: the harness controller derives both deterministically
after the correlated Pi run settles.
