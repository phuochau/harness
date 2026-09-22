# Pi Provider Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Pi as the only agent runtime while making profile families open-ended, resolving locked Pi extensions declaratively, and containing Codex/Devin/Claude bridge behavior in small internal integrations.

**Architecture:** A compatibility-aware profile identity resolver preserves existing v1 hashes. A managed-package resolver maps environment and lock declarations to checked extension paths. Built-in provider adapters supply only auth, credential, settings, skill-projection, managed-resource verification, and recovery differences; the Pi worker and controller retain lifecycle authority.

**Tech Stack:** TypeScript 7, Node >=22.22.2, TypeBox, Vitest, Pi Coding Agent, Git.

**Spec:** `docs/superpowers/specs/2026-09-22-pi-provider-integrations-design.md`

## Global Constraints

- Pi Coding Agent remains the sole agent execution runtime; do not add `AgentRuntime`, OMP, or project-authored harness adapter loading.
- Preserve `harness/profiles/v1`, existing default workflow DSL, legacy normalized profile hashes, `ResolvedProfiles.hash`, and frozen-run recovery behavior.
- New Pi package sources require release-manifest allowlisting, exact lock/environment declarations, and existing install-plan approval; project YAML alone never broadens trust.
- `family` is a reviewer-independence label; `integration` selects host-specific behavior. Unsupported combinations fail before worker launch.
- Codex CLI and Devin CLI remain release-tested; Claude bridge stays experimental until a locked package and real E2E exist.
- Do not fold resource-content freezing, true session resume, result-submission redesign, remote execution, or full real-controller E2E into this refactor.
- Apply TDD per task; use `apply_patch` for edits, review staged diffs, and commit each testable task separately.
- The current shell resolves Node v22.19.0, which is below the repo floor; `/opt/homebrew/bin/node` is v26.7.0. Run setup/tests with `env PATH="/opt/homebrew/bin:$PATH" ...`, and use `env PATH="/opt/homebrew/bin:$PATH" npm ci` after implementation approval if dependencies are absent.

## Review Focus

1. A legacy Codex profile using direct Pi `openai-codex` must retain Pi authentication rather than silently becoming Codex-ACP: Task 1 identity test and Task 3 auth/credential tests.
2. A profile must not opt into `pi-native` while asking for `pi-shell-acp`, `devin`, or `claude-bridge` semantics: Task 1 validation tests.
3. An npm name, resource path, or symlink must not escape managed `node_modules`, including a scoped package and a symlinked parent directory: Task 2 path tests.
4. A package installed at the expected path but with a different `package.json` name/version must fail preflight: Task 2 identity test.
5. An old resolved run must not consult changed project YAML or acquire a new profile hash on restart: Task 1 hash test and Task 5 recovery-path test.

---

## File map

- `src/providers/identity.ts`: built-in integration IDs, legacy inference, profile/integration compatibility, capability flags; no filesystem or process effects.
- `src/providers/types.ts`, `src/providers/registry.ts`, `src/providers/{pi-native,codex-cli,devin-cli,claude-bridge}.ts`: adapter contracts, lookup, and narrowly scoped provider behavior. Only these adapter files know CLI command names and provider-specific settings.
- `src/runtime/managed/package-resolver.ts`: lock/environment to validated managed extension paths; no provider-name branches.
- `src/contracts/profiles.ts`, `src/config/profiles.ts`: open family string, optional explicit integration, hash-compatible legacy normalization, extension-list flattening.
- `src/runtime/managed/{factory,materialize,credentials,paths}.ts`, `src/runtime/pi-worker/runtime.ts`, `src/cli/auth.ts`: call the resolver/registry while preserving the existing Pi process/worker contract.
- `src/pi/dependencies.ts`, `src/defaults/profiles.yaml`, `test/e2e/pi-native-real.test.ts`: provide the current environment and lock at new-run creation; keep resolved-run recovery independent of project config.
- `test/unit/config`, `test/unit/runtime`, `test/integration/install`, `test/e2e`: focused red/green coverage plus a real-provider gate.

## Task 1: Profile identity, capability validation, and v1 hash compatibility

**Files:**
- Create: `src/providers/identity.ts`
- Modify: `src/contracts/profiles.ts`, `src/config/profiles.ts`, `src/defaults/profiles.yaml`
- Test: `test/unit/config/profiles.test.ts`, `test/unit/contracts/schemas.test.ts`, `test/unit/core/routing.test.ts`

**Interfaces:**
- Consumes: existing `ProfileDocument`, `ResolvedProfile`, `resolveProfiles`, and `validateProfiles`.
- Produces: `PiIntegrationId`, `effectiveIntegrationId(profile: { integration?: string; family: string; provider: string }): PiIntegrationId`, `validateProfileIntegration(profile: { id: string; integration?: string; family: string; provider: string; extensions: readonly string[]; skills: readonly { targets: readonly string[] }[] }): PiIntegrationId`, and an optional `ResolvedProfile.integration` field.

- [ ] **Step 1: Write failing tests for open families, legacy hashes, explicit IDs, and incompatible bridges.** Add cases to `profiles.test.ts` using its existing `profileDocument()` and `resources` fixture:

```ts
const before = resolveProfiles(profileDocument(), resources);
const custom = profileDocument();
custom.profiles["implementer-devin"]!.family = "research-agent";
custom.profiles["implementer-devin"]!.integration = "devin-cli";
expect(resolveProfiles(custom, resources).byId["implementer-devin"]?.family).toBe("research-agent");
expect(resolveProfiles(custom, resources).byId["implementer-devin"]?.integration).toBe("devin-cli");
expect(resolveProfiles(profileDocument(), resources).hash).toBe(before.hash);
expect(before.byId["implementer-devin"]?.hash)
  .toBe("sha256:89710cd4924fcb2ac5e753e6466cc0bb6643632c66212c94b367707b32a519fa");
expect(before.hash)
  .toBe("sha256:7082d81d59280c11387bee8a5ef8283df444e138cb4e2dfda6bdf6bfe3418b01");
expect(resolveProfiles(profileDocument(), resources).byId["implementer-devin"])
  .not.toHaveProperty("integration");
custom.profiles["implementer-devin"]!.integration = "unknown-cli";
expect(() => resolveProfiles(custom, resources)).toThrow(/implementer-devin.*unknown-cli/);
```

Add an explicit `pi-native` + `provider: "devin"` rejection; retain direct Pi `planner-codex` as `pi-native`. In `schemas.test.ts` reject empty/unsafe family slugs; in `routing.test.ts` show that a new `research-agent` family remains eligible when `codex` is excluded.

- [ ] **Step 2: Verify RED.** Run `npx vitest run test/unit/config/profiles.test.ts test/unit/contracts/schemas.test.ts test/unit/core/routing.test.ts`; expect the explicit `integration` case to fail because the v1 schema rejects it and the unknown-family case to fail schema validation.

- [ ] **Step 3: Implement identity and normalization.** Replace the family literal union with `Type.String({ pattern: "^[a-z][a-z0-9-]*$" })`, add optional integration with the same slug pattern, and use this exact compatibility logic in `src/providers/identity.ts`:

```ts
export const integrationIds = ["pi-native", "codex-cli", "devin-cli", "claude-bridge"] as const;
export type PiIntegrationId = typeof integrationIds[number];
export function effectiveIntegrationId(profile: {
  integration?: string; family: string; provider: string;
}): PiIntegrationId {
  if (profile.integration !== undefined) {
    if (!integrationIds.includes(profile.integration as PiIntegrationId)) {
      throw new Error(`unknown Pi integration ${profile.integration}`);
    }
    return profile.integration as PiIntegrationId;
  }
  if (profile.family === "codex" && profile.provider === "pi-shell-acp") return "codex-cli";
  if (profile.family === "devin" && profile.provider === "devin") return "devin-cli";
  if (profile.family === "claude" && profile.provider === "claude-bridge") return "claude-bridge";
  return "pi-native";
}
```

Implement `validateProfileIntegration` in the same file: `codex-cli` requires provider `pi-shell-acp` and extension `codex-acp`; `devin-cli` requires provider `devin` and `devin-acp`; `claude-bridge` requires provider `claude-bridge` and `claude-bridge`; `pi-native` rejects those three provider names. Only `devin-cli` and `claude-bridge` allow provider-targeted skills. Include profile ID in errors. In `resolveProfiles`, validate the symbolic extension IDs before path mapping; add `integration` to the normalized object **only when explicitly declared**, retaining every existing legacy hash. Add `integration` IDs to the shipped defaults, without changing existing workflow runners.

- [ ] **Step 4: Verify GREEN and compatibility.** Run `npx vitest run test/unit/config/profiles.test.ts test/unit/contracts/schemas.test.ts test/unit/core/routing.test.ts` and `npm run typecheck`; preserve the existing Devin/Claude fixture extensions and the legacy hash comparison test.

- [ ] **Step 5: Commit.** Run `git diff --check`, then `git add src/providers/identity.ts src/contracts/profiles.ts src/config/profiles.ts src/defaults/profiles.yaml test/unit/config/profiles.test.ts test/unit/contracts/schemas.test.ts test/unit/core/routing.test.ts` and `git commit -m "feat: resolve Pi integration identity from profiles"`.

## Task 2: Locked managed-package resolver and multi-entrypoint resources

**Files:**
- Create: `src/runtime/managed/package-resolver.ts`
- Modify: `src/config/profiles.ts`
- Test: `test/unit/runtime/managed-package-resolver.test.ts`, `test/unit/config/profiles.test.ts`, `test/integration/install/plan.test.ts`

**Interfaces:**
- Consumes: `EnvironmentDocument`, `HarnessLock`, `EffectivePolicy`, `validateEnvironmentAndLock`, `LockedProfileResources`.
- Produces: `resolveManagedExtensions(input: { environment: EnvironmentDocument; lock: HarnessLock; extensionIds: readonly string[]; packageModules: string; policy: EffectivePolicy }): Promise<Readonly<Record<string, readonly string[]>>>`; `LockedProfileResources.extensions` accepts `string | readonly string[]` for legacy test callers.

- [ ] **Step 1: Write failing path and trust tests.** Build an isolated temp directory with `mkdtemp`, create `node_modules/@example/bridge/package.json` containing `{"name":"@example/bridge","version":"1.2.3"}`, and create `src/a.js` and `src/b.js`. Construct a matching `environment.pi_packages` requirement (`scope: "managed"`, `resources.extensions: ["src/a.js", "src/b.js"]`) and a `HarnessLock` npm dependency (`piSource: "npm:@example/bridge@1.2.3"`). Pass `effectivePolicy({ allow: [{ kind: "npm", identity: "@example/bridge", version: "1.2.3", integrity: "sha512-test", registry: "https://registry.npmjs.org/" }] }, undefined, {})`. Assert the returned two absolute paths retain declared order. Add separate tests for `../` and absolute paths, symlinked package directory, symlinked entrypoint, wrong package name/version, missing `b.js`, missing lock mapping, duplicate package IDs, project scope, and unlisted source. In `profiles.test.ts`, assert `["a.js", "b.js"]` is flattened while a legacy single string still resolves. In `plan.test.ts`, assert an unlisted npm source remains a blocking manual step.

- [ ] **Step 2: Verify RED.** Run `npx vitest run test/unit/runtime/managed-package-resolver.test.ts test/unit/config/profiles.test.ts test/integration/install/plan.test.ts`; expect the resolver import/function to be missing and the array-extension assertion to fail.

- [ ] **Step 3: Implement the resolver.** Call `validateEnvironmentAndLock` first; create maps by requirement ID and dependency ID; accept only `scope: "managed"`, `kind: "pi-package"`, `source.kind: "npm"`, a safe npm identity (`/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/`), and `policy.allows({...source, registry: OFFICIAL_NPM_REGISTRY})`. For each ID, compute `join(packageModules, source.identity)`, reject a symlink package root, compare realpaths to ensure every entrypoint remains inside it, reject symlink entrypoint files, and check installed `package.json` name/version against the lock. Return a frozen ID-to-list map. In `resolveProfiles`, change only the extension projection to:

```ts
extensions: sortedUnique(profile.extensions, `extension in ${id}`).flatMap((resourceId) => {
  const declared = resolveResource(resourceId, "extension", resources.extensions);
  return typeof declared === "string" ? [declared] : [...declared];
}),
```

Make `resolveResource` generic (`function resolveResource<T>(id: string, kind: string, resources: Readonly<Record<string, T>>): T`) so both one-path and list resources typecheck. Keep the old one-path fixture output and hashes identical. No alternative entrypoint guessing and no change to package installation recipes.

- [ ] **Step 4: Verify GREEN.** Run the three focused test files above and `npm run typecheck`; run `npx vitest run test/unit/install/policy.test.ts` to confirm the release allowlist cannot be widened by a project lock.

- [ ] **Step 5: Commit.** Run `git diff --check`, then stage the two production files and three test files and commit with `git commit -m "feat: resolve locked Pi extensions from package declarations"`.

## Task 3: Internal adapter registry for authentication and credentials

**Files:**
- Create: `src/providers/types.ts`, `src/providers/registry.ts`, `src/providers/pi-native.ts`, `src/providers/codex-cli.ts`, `src/providers/devin-cli.ts`, `src/providers/claude-bridge.ts`
- Modify: `src/cli/auth.ts`, `src/runtime/managed/credentials.ts`, `src/runtime/pi-worker/runtime.ts`
- Test: `test/unit/runtime/provider-integrations.test.ts`, `test/unit/runtime/managed-credentials.test.ts`, `test/unit/runtime/pi-production-worker.test.ts`

**Interfaces:**
- Consumes: Task 1 `PiIntegrationId`/`effectiveIntegrationId`, `ResolvedProfile`, `ManagedRuntimePaths`, existing `ProfileAuthCommand`.
- Produces: `providerIntegration(profile: ResolvedProfile): PiProviderAdapter`. The adapter has `authCommand(input)`, `authProbe(input)`, `credentialFiles(input)`, `providerSkillProjection(input)`, `environment(input)`, `settings(input)`, `verifyManaged(input)`, and `recoverProviderSession(input)` hooks. Task 3 wires auth/credentials/recovery; Task 4 wires materialization/verification. Hooks return data or evidence; generic lifecycle remains in Pi worker.

- [ ] **Step 1: Write failing adapter tests.** In `provider-integrations.test.ts`, construct resolved legacy profiles for `openai-codex`, `pi-shell-acp`, `devin`, and `claude-bridge`; assert `providerIntegration(profile).id` is `pi-native`, `codex-cli`, `devin-cli`, and `claude-bridge` respectively. Assert interactive auth commands are Pi `/login`, `codex login`, `devin auth login`, and `claude auth login --claudeai`; assert status commands are Pi `auth check --provider <provider> --json --no-refresh`, `codex login status`, `devin auth status`, and `claude auth status`. Add a test that unknown explicit integration never chooses Claude by default. Extend `managed-credentials.test.ts` with a direct-Pi profile copying only `PI_CODING_AGENT_DIR/auth.json`, while a Codex-ACP profile copies only `CODEX_HOME/auth.json`; preserve the existing bounded, no-overwrite checks. Add a process-less provider-session recovery test that `pi-native` returns retry rather than guessing resume.

- [ ] **Step 2: Verify RED.** Run `npx vitest run test/unit/runtime/provider-integrations.test.ts test/unit/runtime/managed-credentials.test.ts test/unit/runtime/pi-production-worker.test.ts`; expect missing registry imports and the generic credential path test to fail.

- [ ] **Step 3: Implement adapter auth/credential hooks.** Move `ProfileAuthCommand` from `src/cli/auth.ts` into `types.ts` (re-export it from `auth.ts` for current callers), define this contract there, and export a closed `Record<PiIntegrationId, PiProviderAdapter>` from `registry.ts`:

```ts
export interface AuthInput {
  readonly profile: ResolvedProfile;
  readonly managedEnvironment: Readonly<Record<string, string>>;
  readonly piExecutable: string;
  readonly codexExecutable?: string;
  readonly devinExecutable?: string;
  readonly claudeExecutable?: string;
}
export interface AuthProbeInput extends AuthInput {
  readonly piExecutableArgs: readonly string[];
  readonly probePrefix: readonly string[];
}
export interface CredentialInput {
  readonly profile: ResolvedProfile;
  readonly paths: ManagedRuntimePaths;
  readonly ambient: Readonly<Record<string, string | undefined>>;
}
export interface CredentialFile { readonly source: string; readonly target: string }
export interface ProfileAuthCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export interface AuthProbeCommand extends ProfileAuthCommand {
  isAuthenticated(stdout: string, stderr: string, exitCode: number): boolean;
}
export type ProviderSkillProjection =
  | { readonly kind: "none" }
  | { readonly kind: "copy-home"; readonly directory: string }
  | { readonly kind: "inline"; readonly id: string; readonly content: string };
export interface ProviderSkillInput {
  readonly paths: ManagedRuntimePaths; readonly name: string;
  readonly id: string; readonly content: string;
}
export interface ProviderSettingsInput {
  readonly paths: ManagedRuntimePaths;
  readonly forwardedSkills: readonly { id: string; content: string }[];
}
export interface ProviderSettingsFile { readonly path: string; readonly content: string }
export interface ProviderVerificationInput {
  readonly profile: ResolvedProfile; readonly managed: ManagedProfileView;
}
export interface PiProviderAdapter {
  readonly id: PiIntegrationId;
  authCommand(input: AuthInput): ProfileAuthCommand;
  authProbe(input: AuthProbeInput): AuthProbeCommand;
  credentialFiles(input: CredentialInput): readonly CredentialFile[];
  providerSkillProjection(input: ProviderSkillInput): ProviderSkillProjection;
  environment(input: { profile: ResolvedProfile }): Readonly<Record<string, string>>;
  settings(input: ProviderSettingsInput): readonly ProviderSettingsFile[];
  verifyManaged(input: ProviderVerificationInput): Promise<{ verified: boolean; evidence: readonly string[] }>;
  recoverProviderSession(input: { piSessionId: string; providerSessionId: string }):
    { status: "retry"; reason: string } | { status: "resume"; sessionId: string };
}
```

Use type-only imports for `ResolvedProfile`, `ManagedRuntimePaths`, `ManagedProfileView`, and `PiIntegrationId`; `auth.ts` imports the registry, not the other way around. Move existing command arguments from `src/cli/auth.ts` and `src/runtime/pi-worker/runtime.ts` into their named adapter files; keep version/model probes and parsed availability in `PiWorkerRuntime`. Move only the credential **source/target path pairs** into adapters, retaining `copyCredential` bounds, `COPYFILE_EXCL`, and mode `0600` in the generic credentials copier. Native Pi auth uses `PI_CODING_AGENT_DIR` or `$HOME/.pi/agent`, not a Codex CLI path. Move the currently unit-tested `recoverInterruptedDevin` helper into `devin-cli.ts` and update its test import; it is not proof that production can resume. Replace `recover()`'s family check with the adapter's conservative `recoverProviderSession` decision; preserve live-process reattachment and collected-result handling. The only fallback for a missing recovery hook is retry. Until Task 4, the new materialization hooks return empty environment/settings and `kind: "none"`; Task 4 implements their provider-specific behavior before wiring them into the materializer.

- [ ] **Step 4: Verify GREEN.** Run the three focused test files and `npm run typecheck`; check the `src/cli/auth.ts`, `src/runtime/managed/credentials.ts`, and `src/runtime/pi-worker/runtime.ts` diffs for remaining family-name branches in auth/credential/recovery paths.

- [ ] **Step 5: Commit.** Run `git diff --check`, stage the new provider modules and affected runtime/CLI/tests, then `git commit -m "refactor: isolate Pi provider auth and credentials"`.

## Task 4: Move provider skill, settings, environment, and verification projection behind adapters

**Files:**
- Modify: `src/providers/types.ts`, `src/providers/{pi-native,codex-cli,devin-cli,claude-bridge}.ts`, `src/runtime/managed/materialize.ts`, `src/runtime/pi-worker/runtime.ts`
- Test: `test/integration/install/managed-runtime.test.ts`, `test/unit/runtime/provider-integrations.test.ts`, `test/unit/runtime/managed-environment.test.ts`

**Interfaces:**
- Consumes: Task 3 `providerIntegration(profile)` and `PiProviderAdapter`.
- Produces: data-returning `environment`, `providerSkillProjection`, `settings`, and `verifyManaged` adapter hooks; the materializer remains the only component that copies skill trees, validates staging destinations, and writes Pi settings.

- [ ] **Step 1: Write failing behavior tests.** Retain existing managed-runtime assertions for Devin's isolated `.agents/skills` copy and headless permission, Claude's closed `claude-bridge.json` plus inline skills, and Codex's strict `settings.json`. Add an explicit `pi-native` materialization fixture with provider-targeted skill rejected at profile resolution; assert it writes no bridge settings and exports no `PI_DEVIN_HEADLESS_PERMISSION`. Add a test for Claude unsafe settings yielding a failed resource verification. Reviewer mutation-tool policy remains a separate milestone, so do not add a test requiring those tools to stay enabled.

- [ ] **Step 2: Verify RED.** First add an adapter-level assertion that `providerIntegration(profile).providerSkillProjection` and `.settings` return the expected data, then run `npx vitest run test/integration/install/managed-runtime.test.ts test/unit/runtime/provider-integrations.test.ts test/unit/runtime/managed-environment.test.ts`; expect the Task 3 default hooks to return `none`/empty for Devin and Claude instead of the required projections.

- [ ] **Step 3: Implement projection hooks.** Use the Task 3 `ProviderSkillInput/Projection`, `ProviderSettingsInput/File`, and `ProviderVerificationInput` types. The adapter result shapes are:

```ts
// pi-native / codex-cli
{ kind: "none" };
// devin-cli
{ kind: "copy-home", directory: join(paths.profileHome, ".agents", "skills", name) };
// claude-bridge
{ kind: "inline", id, content };
// devin-cli environment
{ PI_DEVIN_HEADLESS_PERMISSION: "allow" };
```

Return the exact existing Codex `piShellAcpProvider` settings and Claude strict configuration from `settings`. `materializeProfile` calls the adapter, handles only projection **modes**, and uses its existing `stagePath`, `copyResource`, and bounded `writeFile` functions. Move Devin home-boundary and Claude strict-settings checks into adapter `verifyManaged`; keep common receipt/path checks in `verifyManagedResources`. No `profile.family === ...` or `profile.provider === ...` remains in these two generic modules.

- [ ] **Step 4: Verify GREEN.** Run the three focused suites and `npm run typecheck`; inspect generated Codex/Claude JSON and Devin skill paths with existing assertions; run `npx vitest run test/unit/runtime/pi-worker-results.test.ts` for worker-boundary regression.

- [ ] **Step 5: Commit.** Run `git diff --check`, stage the provider, materializer, worker, and test files, then `git commit -m "refactor: project provider settings through Pi adapters"`.

## Task 5: Wire new-run package declarations while retaining frozen recovery

**Files:**
- Modify: `src/runtime/managed/factory.ts`, `src/runtime/managed/paths.ts`, `src/pi/dependencies.ts`, `test/e2e/pi-native-real.test.ts`
- Test: `test/unit/runtime/managed-factory.test.ts`, `test/unit/runtime/managed-paths.test.ts`, `test/integration/install/provider-resolution.test.ts`, `test/unit/config/compiler.test.ts`

**Interfaces:**
- Consumes: Task 2 `resolveManagedExtensions`, Task 1 profile resolver, Task 3/4 registry.
- Produces: `createManagedPiRuntime(input: ManagedPiRuntimeBaseInput & { profiles: ProfileDocument; environment: EnvironmentDocument; lock: HarnessLock }): Promise<ManagedPiRuntimeBundle>`; unchanged `createManagedPiRuntimeFromResolved(input)` for persisted-run recovery.

- [ ] **Step 1: Write failing factory and fixture integration tests.** In `provider-resolution.test.ts`, stage a temp managed `node_modules/@tian.zuo/pi-devin-acp` with the locked `package.json` name/version and **only** `dist/custom.js`, plus a temp `.bin/pi` file. Declare the shipped allowlisted dependency ID `pi-devin-acp` with `resources.extensions: ["dist/custom.js"]`, then declare a `pi-native` implementation profile with family `research-agent`, provider `openai-codex`, and extension ID `devin-acp`. Call `createManagedPiRuntime` with this environment, lock, profile document, temp data home, and current harness package root; assert its managed extension path and `buildPiLaunchSpec` `--extension` argument use `dist/custom.js`, not `index.ts`. Add a test that changing project YAML after resolved-run creation cannot change `createManagedPiRuntimeFromResolved`'s profile paths or hash. In `managed-factory.test.ts`, assert a missing managed package fails before Pi launch. Preserve its three existing frozen-package identity assertions.

- [ ] **Step 2: Verify RED.** Run `npx vitest run test/unit/runtime/managed-factory.test.ts test/integration/install/provider-resolution.test.ts test/unit/config/compiler.test.ts`; expect the factory to ignore the declared `dist/custom.js` and fail looking for its hardcoded `index.ts` path.

- [ ] **Step 3: Implement the factory wiring.** Add `environment` and `lock` to the new-run factory input. Extract `managedPackagesPath({ dataHome, runtimeVersion }): string` in `paths.ts` from the existing runtime-root calculation; make `managedRuntimePaths(...).packages` call it. Build requested extension IDs from `ProfileDocument` and call:

```ts
const extensions = await resolveManagedExtensions({
  environment: input.environment,
  lock: input.lock,
  extensionIds: Object.values(input.profiles.profiles).flatMap((profile) => profile.extensions),
  packageModules: join(managedPackagesPath({ dataHome, runtimeVersion: input.runtimeVersion }), "node_modules"),
  policy: effectivePolicy(builtInBaseline(), undefined, {}),
});
const profiles = resolveProfiles(input.profiles, {
  extensions, skills, promptTemplates, mcp: {},
});
```

Remove the three hardcoded extension-ID/package-path branches and both `"planner-codex"` path-helper placeholders. Pass `project.environment` and `project.lock` in `src/pi/dependencies.ts`; pass parsed default environment/lock in the real test. Do **not** add environment/lock reads in `createManagedPiRuntimeFromResolved`; retain `assertPackageIdentity` and profile materialization from the persisted resolved config.

- [ ] **Step 4: Verify GREEN and install policy.** Run the four focused test files, `npx vitest run test/integration/install/plan.test.ts test/unit/install/policy.test.ts test/integration/install/managed-runtime.test.ts`, `npm run typecheck`, and `npm run build`. Existing default Codex/Devin extension IDs must still resolve from their locked npm identities.

- [ ] **Step 5: Commit.** Run `git diff --check`, stage the factory, startup, real test, and new/updated fixtures, then `git commit -m "feat: wire locked Pi packages into new-run profiles"`.

## Task 6: Exercise shipped workflows and hand off verification evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-pi-provider-integrations-design.md` status after successful verification; do not modify tests merely to make them pass.
- Test: `test/e2e/production-pipeline.test.ts`, `test/e2e/pi-native-real.test.ts`, existing packed-consumer suites.

**Interfaces:**
- Consumes: Tasks 1–5 public factory and adapter interfaces.
- Produces: evidence that routing a new family and legacy Codex/Devin profiles works through Pi without changing scheduler semantics.

- [ ] **Step 1: Run deterministic E2E and packed-consumer suites.** Run `npx vitest run test/e2e/production-pipeline.test.ts test/e2e/fake-controller.test.ts test/integration/package-smoke.test.ts test/integration/install`; assert controller reaches its existing verified terminal state and the packed default Pi extensions remain loadable.

- [ ] **Step 2: Run full local verification.** Run `npm run verify` (typecheck, build, all Vitest suites, pack dry-run). Then run `npm run e2e:real` only if both local CLI subscriptions and Node >=22.22.2 are available; record the command, pass/fail, and the provider/probe evidence. If credentials are absent, report this gate as not run, not as passing. Re-run the existing race/recovery suites after any fix.

- [ ] **Step 3: Review and fix the branch.** Search `src/runtime/pi-worker`, `src/runtime/managed`, `src/config`, and `src/core` for residual `family === "codex" | "devin" | "claude"` dispatch; only the centralized v1 compatibility mapping and provider adapter modules may name those agents. Inspect `git diff main...HEAD` for unintended workflow, security-policy, or result-protocol changes. Update the spec status to `Implemented` only if its complete success criteria and applicable E2E evidence are met.

- [ ] **Step 4: Commit verified documentation.** Run `git diff --check`; if all required evidence exists, stage the spec-status edit and commit with `git commit -m "docs: record verified Pi provider integration"`. Report which real-provider test was run, and keep any unverified gate explicitly open.
