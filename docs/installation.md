# Installation and setup

## Requirements

- Node.js `>=22.22.2`
- Git and GitHub CLI
- authenticated Codex CLI and Devin CLI subscriptions

The project lock pins Pi `0.86.1`, `@junghanacs/pi-shell-acp@0.11.1`,
`@tian.zuo/pi-devin-acp@0.3.4`, TypeBox `1.3.34`, Spec Kit `0.8.7`, and
Superpowers `6.4.1`. Setup uses those exact identities and integrity values.

## Initialize

```bash
npm exec --yes --package pi-multi-agent-harness@0.1.0 -- harness init .
```

Initialization creates a ready `.harness/workflow.yaml`, `profiles.yaml`,
`environment.yaml`, `policy.yaml`, `harness.lock`, workflow presets, and
`.pi/settings.json`. Existing customized files are never overwritten.

The default install inventory includes only the Pi harness, the Codex CLI ACP
bridge, and the Devin CLI ACP bridge. Global Pi packages, skills, MCP servers,
and unrelated agent configuration are not imported into worker profiles.

## Review and apply setup

```bash
harness setup --dry-run .
harness setup --yes .
```

The dry run is content-addressed. Review the plan hash, sources, versions,
digests, argv, scope, and rollback notes before approval. `--yes` authorizes
only that exact plan. `bootstrap` remains an alias for `setup` for one release.

Managed packages and profile homes live below:

```text
$XDG_DATA_HOME/pi-harness/runtimes/<harness-version>/
  packages/
  profiles/<profile-id>/
```

## Authenticate local CLI subscriptions

Managed profiles do not import credentials merely because a project is opened.
Authenticate interactively inside each isolated profile with:

```bash
harness auth planner-codex .
harness auth implementer-devin .
```

Or explicitly copy only the provider's allowlisted local CLI credential:

```bash
harness auth planner-codex . --reuse-local
harness auth implementer-devin . --reuse-local
```

The harness never prints or stores credential values in receipts. Codex uses
`codex login`; Devin uses `devin auth login`. API-key billing is not selected as
an automatic fallback.

## Diagnose and start

```bash
harness doctor --json .
harness start .
```

Doctor freshly checks Node, Git, GitHub, the locked managed packages, both
CLIs, subscription readiness, profile resources, and project configuration.
Receipts are diagnostic history, not current-health proof.

There is no remote-control service in this release. `start` runs the local Pi
orchestrator; durable child sessions and repository state are recovered with
`harness recover` after interruption.
