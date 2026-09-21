# Security model

## Trust boundary

Before setup approval, the launcher parses only bounded declarative files,
inert `.pi/settings.json`, package metadata, and Git metadata. It does not load
project modules, execute project scripts, start model turns, or import global
Pi configuration.

The release baseline is a ceiling. Project and machine policy may narrow it but
cannot authorize a new source. Npm packages are bound to exact identity,
version, registry, and integrity. Setup uses argv arrays with `shell: false` and
installs only an explicitly approved content-addressed plan.

## Managed profiles

Every worker gets an isolated HOME, Pi agent directory, XDG config/data roots,
explicit extension paths, selected skill paths, and an explicit tool surface.
Global packages, skills, prompt templates, context files, plugins, and MCP
servers are disabled by default.

Codex runs through the locally authenticated Codex CLI bridge; Devin runs
through the locally authenticated Devin CLI ACP bridge. Credentials enter a
managed profile only through interactive `harness auth` or the explicit
`--reuse-local` option, which copies only the selected provider's allowlisted
file and never overwrites an existing managed login. The harness does not
silently fall back to API-key billing.

Devin headless permissions are auto-approved only inside the task's isolated
worktree and allowed-path contract. Codex CLI native tools cannot be hidden by
Pi without creating a false tool contract, so mutation safety is enforced by
worktree isolation, protected paths, candidate diff validation, and evidence
acceptance rather than by prompt claims alone.

## Credentials and logs

Never expose production databases, production API keys, or production
infrastructure credentials. Use minimum disposable development/test access.
Doctor and setup receipts do not persist credential values. Detached provider
stderr is suppressed because it cannot be safely redacted after a controller
crash; durable diagnostics come from 0600 Pi event and result files.

## Protected state

Workers may read approved Spec Kit artifacts but may not modify the
specification, architecture, `.harness/**`, `.pi/settings.json`, or controller
state. Each assignment binds allowed paths, base commit, worktree, role,
profile hash, required Superpowers disciplines, verification commands, and a
structured result schema. Independent review uses a different provider family.

Exact PID/start/executable/token identity is rechecked before cancellation.
Ambiguous external effects and incomplete terminal evidence block or retry; they
are never promoted to success.

## Reporting

Report vulnerabilities privately to the maintainers with the affected version
and a minimal reproduction. Do not attach real credentials or target production
systems.
