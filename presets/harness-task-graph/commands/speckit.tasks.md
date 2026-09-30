---
description: Generate Spec Kit tasks and a deterministic harness task graph
strategy: wrap
---
{CORE_TEMPLATE}

Render every phase heading as `## Phase N: <name>` and every task as exactly:

`- [ ] T001 [P] [US1] Description | complexity=standard | why="Touches parser and CLI contract" | deps=[] | ac=["FR-001"] | paths=["src/file.ts"]`

`[P]` and labels are optional. `complexity` is exactly one of `mechanical`,
`standard`, or `complex`, assessed per task:

| Complexity | Guidance |
| --- | --- |
| `mechanical` | A complete prescription, a small isolated change, usually one or two files, little integration judgment. |
| `standard` | Coordination across files, established patterns to adapt, ordinary debugging or integration decisions. |
| `complex` | Architecture, ambiguous design judgment, broad codebase understanding, or subtle high-risk behavior. |

`why` is a canonical JSON string naming task-specific evidence for the
assessment — a generic statement such as "this is complex" does not satisfy
this instruction. The normalized reason must be nonempty and at most 500
characters. The three `deps`, `ac`, and `paths` fields are required JSON
string arrays. Escape a literal description pipe as `\|`. Then append exactly
one EOF block with no content after it:

<!-- harness-task-metadata:v2
{"schema":"harness/task-metadata/v2","tasks":[{"acceptanceRefs":["FR-001"],"complexity":"standard","complexityReason":"Touches parser and CLI contract","dependsOn":[],"description":"Description","id":"T001","labels":["US1"],"ownedPaths":["src/file.ts"],"parallelEligible":true,"phase":"<name>"}]}
-->

Include one metadata record per visible task in visible order and copy every
field, including `complexity` and `complexityReason`, from the visible entry
after normalization. Emit the JSON line as canonical JSON: object keys sorted
by locale-independent UTF-16 code-unit order, no insignificant whitespace, and
already-normalized arrays. Do not write `task-graph.json` and do not compute a
hash: the harness controller derives both deterministically
after the correlated Pi run settles.
