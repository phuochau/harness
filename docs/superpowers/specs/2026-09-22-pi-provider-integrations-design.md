# Pi Provider Integrations — Design

**Status:** Proposed for review
**Date:** 2026-09-22
**Baseline:** `51651cf`
**Decision:** Pi Coding Agent remains the sole agent execution runtime.

## Intent and success

The harness owner wants to change planning, implementation, and review workflows by selecting profiles, and to add a Pi-backed coding agent without editing scheduler or controller logic. Codex CLI and Devin CLI remain the release-tested integrations. Onboarding a new package still requires an approved release source and lock entry. A bridge with nonstandard authentication, credentials, provider configuration, or recovery may require a small harness adapter; merely declaring an arbitrary package is not a promise that its agent works.

This milestone succeeds when:

1. Workflow routing and reviewer-independence policy use profile data, not a closed list of agent names.
2. The managed runtime resolves a profile's Pi extension entrypoints from its declared environment package and locked dependency, not a Codex/Devin/Claude switch or guessed package path.
3. Provider-specific authentication, credential projection, Pi settings, provider-skill projection, and recovery policy live behind a small internal integration registry. Generic worker lifecycle, controller, scheduler, and Pi launch do not branch on agent family.
4. Existing `harness/profiles/v1` Codex and Devin profiles retain their behavior and can recover existing runs. Unsupported integration or package combinations fail before worker launch with an actionable diagnostic.
5. Tests prove the generic package path, Codex and Devin compatibility, an unsupported-provider failure, and the packed/real Pi paths that are already release-tested.

## Existing constraints

- `ProfileFamilySchema` currently accepts only `codex`, `devin`, and `claude`; reviewer policy compares family values.
- `environment.pi_packages` already names package IDs, locked dependencies, scope, and extension-relative paths. `harness.lock` records exact package identities and versions.
- The install policy has a release-manifest allowlist ceiling; project configuration alone cannot authorize a new npm source. The exact install plan still requires user approval.
- The managed factory currently duplicates that declaration with hardcoded package names and entrypoint candidates, while auth, credentials, profile materialization, and probing branch by family.
- `buildPiLaunchSpec` is already provider-neutral: it launches Pi with a resolved provider/model and extension paths.
- `claude` has partial adapter code and tests, but no default locked package or real subscription end-to-end gate. This design does not advertise it as release-tested.
- Active runs persist resolved profile hashes and a frozen harness package identity. A migration must not silently reinterpret an existing profile or erase its recovery evidence.

## Chosen approach

Use a **built-in, closed integration registry plus a generic Pi integration**. No runtime loading of project-authored JavaScript as a harness adapter. A new Pi package is admitted through the harness release manifest, project lock, environment declaration, and existing exact-plan approval; Pi executes its extension in the existing isolated worker environment. If that extension needs special host behavior, a reviewed adapter is added to the harness and assigned an integration ID.

This is narrower than a plugin framework, but more extensible than merely moving current `if (family === ...)` statements into another file. Alternatives rejected:

- **Reorganize existing branches only:** simpler migration, but package resolution and the schema remain closed to new families.
- **Dynamic harness integration plugins:** permits arbitrary provider code during setup and recovery, enlarging the trust boundary and making durable-run compatibility harder to prove.

## Profile and integration identity

`family` becomes a validated nonempty slug string, not a union of three literals. It is the **review-independence group**: profiles with the same family cannot independently review one another when the workflow requires a different family. It is not a command name, package name, or transport selector.

`provider` and `model` retain their Pi meanings. A profile gains an optional `integration` ID in `harness/profiles/v1`. Built-in IDs are `pi-native`, `codex-cli`, `devin-cli`, and `claude-bridge`. New profiles should state this ID explicitly. For existing documents without it, one compatibility resolver maps the current Codex `pi-shell-acp`, Devin `devin`, and Claude bridge combinations to their existing behavior; all other legacy combinations resolve to `pi-native` and must pass its normal provider/model probe. The compatibility mapping is centralized, tested, and not copied into runtime layers.

For newly explicit profiles, the resolved profile stores `integration`, and its per-profile and collection hashes include that field. For a legacy profile, the resolved object has no new serialized field; a deterministic compatibility function derives the effective integration from its existing `family` and `provider`. Both its per-profile hash and `ResolvedProfiles.hash` therefore remain byte-for-byte compatible with current v1 normalization. A persisted legacy run can be interpreted after a restart without inventing a new profile identity. If its frozen harness package identity requires old code, recovery continues to use that frozen package rather than silently upgrading it.

The registry is internal TypeScript code keyed by integration ID. Its contract covers only behaviors that differ:

- profile validation and declared capabilities (for example, provider-skill projection);
- interactive auth command and noninteractive auth probe;
- optional local credential projection and provider-specific managed Pi settings;
- provider-session recovery decision, if supported.

The generic `pi-native` integration uses Pi's own auth and model probe, makes no CLI credential-copy assumptions, writes no provider-specific settings, and does not claim session resumption. Codex, Devin, and the existing Claude bridge keep their current behavior in separate adapter modules. A missing hook means “unsupported,” not “fall through to Claude” or “assume resumable.” The controller's attempt lifecycle and completion authority remain unchanged.

## Locked extension resolution

For each profile extension ID, new-run creation finds the matching `environment.pi_packages` requirement and its `harness.lock` dependency. `createManagedPiRuntime` receives those two validated documents in addition to profiles; `createManagedPiRuntimeFromResolved` remains the recovery path and does not reread mutable project configuration. The dependency must be a managed Pi package with a supported, locked source admitted by the release trust policy. Its declared `resources.extensions` gives one or more package-relative entrypoints. The resolver obtains the managed package root from the locked npm identity (including scoped package names), validates every relative component, rejects absolute paths, `..`, and symlink escapes, and requires regular existing files. It passes the ordered entrypoint list to profile resolution, which flattens package IDs in deterministic sorted order and preserves each package's declared entrypoint order. The package requirement ID is the symbolic extension ID in the profile.

The resolver does not guess `index.ts`/`dist/index.js` alternatives; the declarative entrypoints are authoritative. Missing package, missing entrypoint, duplicate IDs, unmatched lock entry, unsupported source kind, or an unapproved integration are preflight errors. After a new source is deliberately added to the release manifest and locked, the existing installer can install it and a `pi-native` profile can consume it without editing `factory.ts`, provided the Pi provider/model passes the normal probe. This does not imply arbitrary provider-specific auth or credential support. Recovery uses the frozen resolved profile paths and package identity already persisted with the run, without consulting a changed project configuration.

Project-owned harness extensions, including worker transport, remain separate from managed provider extensions. The existing resource-freezing/content-hash hardening proposal is a separate milestone; this refactor must not weaken current package identity and run receipt checks.

## Data flow and ownership

```text
workflow runner preference -> profile ID
profile -> family + integration ID + Pi provider/model + symbolic resources
environment + lock -> verified managed package entrypoints
integration registry -> validated capabilities, auth, credentials, settings, recovery policy
Pi worker runtime -> Pi launch, process observation, result collection
controller -> verification, review, retries, integration, DONE
```

The registry does not schedule jobs or mark tasks complete. Integrations never call Codex/Devin as alternate runtimes; they only prepare how Pi connects to them. Reviewer independence continues to compare `family`, so a new family requires no scheduler change.

## Compatibility and diagnostics

- The existing default profiles and workflow DSL remain valid. A new install emits explicit integration IDs; old v1 documents still compile through the centralized compatibility resolver. Adding a source to a project lock without release-manifest approval cannot bypass installation policy.
- A profile whose integration ID is unknown, whose provider/extension combination is incompatible, or whose provider skills cannot be projected fails at config/preflight with profile ID and reason.
- Claude bridge code is retained as an explicit experimental adapter for existing configs, but no default Claude profile is added and no production-readiness claim is made until its package is locked and real E2E passes.
- The `agent_plugins` field in environment configuration is not repurposed as provider integration loading. Its separate CLI plugin probes still know specific host applications; they do not select a Pi worker provider and are outside this execution-path refactor.
- Authentication credentials remain local to managed homes and are never logged in diagnostics.

## Verification

1. Unit tests cover integration resolution, unknown IDs, legacy mapping and stable legacy hashes, arbitrary family strings, reviewer independence, capability checks, and adapter-specific auth/probe/recovery behavior.
2. Package-resolution tests cover scoped npm package names, declared non-default and multiple entrypoints, missing package/file, duplicate resource ID, traversal, symlink escape, and lock/environment mismatch.
3. A fixture integration test selects a locally staged, declared managed Pi extension through a `pi-native` profile and verifies Pi receives its declared entrypoint; a separate installer-policy test proves an unlisted source is denied. Packed-consumer tests verify the shipped Codex and Devin package path, and existing production-controller tests remain green.
4. The opt-in real Pi test continues to exercise Codex planning, Devin implementation, and independent Codex review; it is run where both subscriptions are authenticated. A deterministic controller E2E protects workflow routing without relying on subscription availability.
5. Typecheck, unit, integration, race/recovery, and packed-consumer suites pass before this milestone is called complete. Real-provider evidence is reported separately if local credentials or supported Node are unavailable.

## Non-goals

No OMP or generic `AgentRuntime`; no arbitrary harness plugin loader; no implicit installation of unapproved packages; no full content-addressed resource freezing, session-resume implementation, result-submission redesign, remote execution, or full-controller real-provider E2E in this refactor. Those have separate correctness and release gates.
