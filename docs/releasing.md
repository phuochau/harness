# Releasing

## Preconditions

- `package.json`, the tag, defaults, lock, TypeScript release manifest, and JSON
  release manifest agree on the version and trusted sources.
- Node is `>=22.22.2`.
- Codex CLI and Devin CLI are authenticated with disposable development
  subscription accounts for the opt-in real gate.
- The npm package namespace and trusted publishing identity are already owned.

## Local gates

```bash
npm ci
npm run verify
PATH=/opt/homebrew/bin:$PATH npm run e2e:real
```

`verify` runs typecheck, build, the full fake/crash/isolation suite, and
`npm pack --dry-run --json`. Inspect the tarball: it may contain the declared
`dist`, `bin`, `presets`, `src/defaults`, README, SECURITY, and docs, but never
tests, journals, credentials, `.harness-output`, or source maps containing
embedded source text.

The real gate is not a mock and must not pass by skipping. It creates a
disposable Git repository, uses Pi with the authenticated Codex CLI to create a
Spec Kit artifact, then uses Pi with the authenticated Devin CLI to implement,
verify, commit, and emit structured evidence. `HARNESS_E2E_REAL=1` is set by the
script.

Current release scope is Codex CLI plus Devin CLI. No Claude, remote-control,
or second orchestration service is required by the default install or release
gate.

Also verify production source, active tests, scripts, and release workflows do
not reference a removed secondary execution plane. Historical design documents
may retain migration context; runtime behavior may not.

## Automated release

Push an annotated `vX.Y.Z` tag. The workflow must validate tag/version
equality, rerun all non-subscription gates, verify npm ownership, publish with
trusted publishing and provenance, query the registry integrity, and attach
that digest as release evidence.

The tarball cannot embed its own final digest. The immutable baseline
authorizes package identity/version; setup resolves `dist.integrity`, binds it
into the approved plan hash, and verifies it again immediately before install.

Never substitute a different package, registry, tag, CLI account, or billing
path when a prerequisite fails.
