# Security model

## Trust boundary

Before install approval, the launcher only parses the fixed declarative files
under `.harness/`, inert `.pi/settings.json`, bounded metadata inside the
project-local Pi cache, and Git metadata. It does not import project modules,
load Pi extensions, execute workflow argv, run package lifecycle scripts, or
start a model turn.

The immutable release baseline is a ceiling. Machine policy and project policy
may narrow it; neither can authorize a new source. Npm sources bind exact
identity and version. For the harness package itself, bootstrap resolves the
registry's `dist.integrity` before presenting the plan, places the resulting
SHA-512 digest inside `planHash`, and queries it again immediately before
install. This avoids the impossible circular requirement that a tarball embed
its own final digest.

All subprocess calls use argv arrays with `shell: false`. Generic npm recipes
include `--ignore-scripts`. Pi packages are special: after explicit approval,
Pi may execute package/extension code. The plan calls this out, installs only
the locked source, atomically projects all four resource filters, performs an
inert metadata probe, then loads resources in a bounded child process without a
model turn. That child is fault containment, not a security sandbox.

## Credentials

Do not provide production database credentials, production API keys, or
production infrastructure credentials. Give each worker the minimum disposable
development/test credentials required by its assignment. Receipts and doctor
reports never persist stdout, stderr, environment variables, auth tokens, or
credential-bearing URLs.

## Protected state

Workers may read `spec.md`, `plan.md`, and `tasks.md`, but may not modify the
specification, architecture, `.harness/**`, `.pi/settings.json`, or controller
state. Each assignment declares allowed paths, commit, worktree, role, required
Superpowers evidence, and verification commands. Reviews run in detached,
read-only worktrees and must use a different worker kind.

## Reporting

Report suspected vulnerabilities privately to the repository maintainers.
Include the affected version, minimal reproduction, and whether secrets or
external side effects were involved. Do not attach real credentials or target
production systems while reproducing an issue.
