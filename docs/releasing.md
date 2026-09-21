# Releasing

## Preconditions

- The `pi-multi-agent-harness` npm namespace already exists and the trusted
  publishing actor is an owner. First-time namespace reservation is manual.
- `package.json`, the tag (`vX.Y.Z`), defaults, lock, TypeScript release
  manifest, and JSON release manifest agree on the version.
- The pinned Pi, TypeBox, Spec Kit, Herdr, and worker compatibility environment
  is disposable and authenticated only where the smoke requires it.

## Local gates

```bash
npm ci
npm run verify
npm pack --dry-run --json
```

Inspect the file list. It may contain npm-required metadata plus `dist/`,
`bin/`, `presets/`, `src/defaults/`, README, SECURITY, and docs. It must not
contain tests, run journals, receipts, credentials, `.harness-output/`, or
source maps with embedded source text. The packed-consumer test installs exact
peer versions, runs `harness --help`, imports the public module, and loads the
extension through Pi's real resource loader.

The subscription smoke is intentionally opt-in and must target disposable
accounts and a disposable GitHub repository. Set `HARNESS_E2E_REAL=1`,
`HARNESS_E2E_DISPOSABLE=1`, `HARNESS_E2E_GITHUB_REPO=owner/repo`, and
`HARNESS_E2E_COMMAND` to a JSON argv array for the environment-owned scenario
driver. The driver performs the real run and prints one JSON object containing
`runState: "DONE"`, `verified: true`, and the created pull request URL and
repository. The test executes that argv directly with no shell.

Publication is blocked unless this smoke passes on the `harness-e2e` runner.
A skipped test does not satisfy the release gate.

## Automated release

Push an annotated `vX.Y.Z` tag. The release workflow:

1. validates tag/version equality;
2. reruns typecheck, build, fake E2E, packed consumer, and pinned compatibility;
3. verifies `npm whoami` and package ownership against the configured expected
   owner;
4. publishes with npm trusted publishing and `--provenance`;
5. queries `npm view pi-multi-agent-harness@X.Y.Z dist.integrity`; and
6. uploads that digest and workflow provenance as GitHub release evidence.

The published tarball's digest cannot be embedded inside that same tarball.
Instead the immutable baseline authorizes the exact package identity/version
and requires live registry digest resolution. Bootstrap binds the resolved
SHA-512 value into the user-approved plan and verifies it again immediately
before invoking Pi.

Never silently switch to a different package name, scope, registry, tag, or
worker account when a release prerequisite fails.
