# Coding Model Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select exact names or versioned IDs for popular coding models and run declared local/OpenAI-compatible models through isolated Pi profiles.

**Architecture:** Preserve `provider` + `model` as the executable identity. Add optional `model_config` to a `pi-native` profile, validate and hash it, then generate that profile's managed Pi `models.json`. Keep hosted Pi catalog providers configuration-only. Make worker preflight require an exact provider/model match and ship copyable examples without activating additional workers in the default workflow.

**Tech Stack:** TypeScript 7, Node >=22.22.2, TypeBox, Vitest, Pi Coding Agent 0.86.1.

**Spec:** `docs/superpowers/specs/2026-09-28-coding-model-profiles-design.md`

## Global Constraints

- Pi remains the sole agent runtime. No new bridge package, credential store, global Pi import, or alternate scheduler.
- Existing `harness/profiles/v1` documents and legacy resolved hashes remain byte-for-byte compatible when `model_config` is absent.
- `model` is the exact provider ID, including a version/tag when chosen; `model_config.name` is display-only. Do not invent a universal version parser or silently choose a different model.
- `model_config` applies only to `pi-native` and one OpenAI-compatible endpoint/model in its own isolated profile.
- Only HTTP loopback or HTTPS endpoint URLs are accepted; non-loopback HTTPS requires `api_key_env`. No literal project-file secrets or `!command` key resolvers.
- Environment keys are forwarded by exact declaration only. Model configuration must be frozen in the resolved profile and generated managed resource, with no ambient model discovery.
- Default Codex/Devin runners and release lock remain unchanged; extra model examples are opt-in.
- Use `env PATH="/opt/homebrew/bin:$PATH"` for commands: shell Node 22.19.0 is below the repository floor, while Homebrew Node 26.7.0 satisfies it.
- Apply TDD to behavior changes. Commit each independently testable task.

## Review Focus

1. Prefix collisions: `glm-5.3-flash` must not satisfy a request for `glm-5.3` (Task 3).
2. Existing profiles without `model_config` must retain their known hashes and must not acquire a `models.json` (Tasks 1–2).
3. A declared `api_key_env` with no value at launch must leave a remote custom model unavailable without leaking a value (Task 2).
4. A project must not inject `!command`, a literal API secret, or a non-loopback HTTP endpoint through the new config (Task 1).
5. Two profiles for different local models must receive distinct managed catalogs and frozen configuration after rematerialization (Task 2).

---

## File map

- `src/contracts/profiles.ts`: optional, narrow `model_config` schema.
- `src/config/profiles.ts`: validate endpoint/auth policy and include optional model config in resolved profile/hash only when declared.
- `src/providers/identity.ts`: reject custom model config on CLI bridges.
- `src/runtime/managed/{materialize,environment,factory}.ts`: write generated Pi `models.json` and forward one declared credential environment key.
- `src/runtime/pi-worker/runtime.ts`: exact provider/model table matching and managed catalog verification.
- `docs/model-profiles.md`: opt-in hosted and local coding model examples and activation/auth instructions.
- `test/unit/config`, `test/integration/install`, `test/unit/runtime`, `test/integration/pi-worker`: focused behavior tests.

## Task 1: Exact model identity and custom endpoint validation

**Files:**
- Modify: `src/contracts/profiles.ts`, `src/config/profiles.ts`, `src/providers/identity.ts`
- Test: `test/unit/config/profiles.test.ts`, `test/unit/contracts/schemas.test.ts`

**Interfaces:**
- Consumes: existing `ProfileDocument`, `ResolvedProfile`, `resolveProfiles`, and `validateProfileIntegration`.
- Produces: optional `ResolvedProfile.modelConfig` with `{ baseUrl: string; api: "openai-completions"; name?: string; apiKeyEnv?: string }` and unchanged resolved shape/hash for old profiles.

- [ ] **Step 1: Write failing tests.** In `profiles.test.ts`, add a native profile with `provider: "ollama"`, `model: "qwen3-coder:30b"`, and `model_config: { base_url: "http://127.0.0.1:11434/v1", api: "openai-completions", name: "Qwen3-Coder 30B" }`; assert exact model string and normalized config survive resolution and change its hash when the model ID or URL changes. Assert the existing legacy hash constants still match without the field. Add rejection cases for bridge integration, HTTP remote URL, remote HTTPS without `api_key_env`, invalid env key, shell-command key, and unknown config keys. Assert HTTPS with a declared env key is accepted without storing a key value.
- [ ] **Step 2: Verify RED.** Run `env PATH="/opt/homebrew/bin:$PATH" npx vitest run test/unit/config/profiles.test.ts test/unit/contracts/schemas.test.ts`; expect the new schema/validation cases to fail for missing support.
- [ ] **Step 3: Implement.** Add the optional closed `model_config` schema with snake_case project fields. Validate URL with `new URL()`: protocol/hostname rules above, no userinfo, fragment, or query; validate env key with the managed-environment identifier pattern. Reject `model_config` unless effective integration is `pi-native`. Normalize to camelCase on `ResolvedProfile` only if declared; its existing canonical hash will then cover the selected endpoint and display name. Derive the Pi model ID by stripping only an exact `${provider}/` prefix when generating the catalog in Task 2.
- [ ] **Step 4: Verify GREEN.** Re-run the focused tests and `env PATH="/opt/homebrew/bin:$PATH" npm run typecheck`.
- [ ] **Step 5: Commit.** Review `git diff --check`; commit the three production files and two test files as `feat: validate exact coding model profiles`.

## Task 2: Materialize custom models in isolated Pi homes

**Files:**
- Modify: `src/runtime/managed/materialize.ts`, `src/runtime/managed/factory.ts`, `src/runtime/pi-worker/runtime.ts`
- Test: `test/integration/install/managed-runtime.test.ts`, `test/unit/runtime/managed-environment.test.ts`

**Interfaces:**
- Consumes: Task 1 `ResolvedProfile.modelConfig`.
- Produces: optional `ManagedProfileView.modelCatalogPath` and `modelCatalogHash`; generated `<piAgentDir>/models.json` with `providers[profile.provider] = { baseUrl, api, apiKey, models: [{ id, name? }] }`. For loopback without `apiKeyEnv`, `apiKey` is the non-secret `local`; otherwise it is `$ENV_NAME` and only that key is forwarded.

- [ ] **Step 1: Write failing integration tests.** Materialize two native profiles with different local IDs/tags and assert each managed catalog contains only its exact model, endpoint and optional display name. Materialize twice and assert the declaration survives replacement; old profiles still have no `models.json`. Assert unrelated ambient secrets are absent from `ManagedProfileView.environment`, while a declared HTTPS `api_key_env` is present only for its profile. Assert a missing declared environment value leaves no injected value. Assert the catalog is a mode-0600 regular file and that its content hash is bound to the managed receipt.
- [ ] **Step 2: Verify RED.** Run `env PATH="/opt/homebrew/bin:$PATH" npx vitest run test/integration/install/managed-runtime.test.ts test/unit/runtime/managed-environment.test.ts`; expect missing catalog/forwarding assertions to fail.
- [ ] **Step 3: Implement.** Generate the closed Pi JSON object from validated resolved fields inside the atomic staging directory. Add its relative path and SHA-256 content hash to the receipt body and optional path/hash to `ManagedProfileView`; `verifyManagedResources` must check both file identity and content hash. In `factory.ts`, pass `[profile.modelConfig.apiKeyEnv]` only when declared to materialization; keep other forwarded keys empty. Never persist the environment variable's value in a receipt or model file.
- [ ] **Step 4: Verify GREEN.** Run the focused tests and `env PATH="/opt/homebrew/bin:$PATH" npm run typecheck`. Confirm bridge settings/credential preservation tests remain green.
- [ ] **Step 5: Commit.** Review `git diff --check`; commit production and test files as `feat: materialize isolated custom Pi models`.

## Task 3: Exact preflight and copyable coding model profiles

**Files:**
- Modify: `src/runtime/pi-worker/runtime.ts`, `README.md`, `docs/installation.md`
- Create: `docs/model-profiles.md`
- Test: `test/unit/runtime/pi-model-probe.test.ts`, `test/integration/pi-native-auth-probe.test.ts`, `test/integration/init.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 `ResolvedProfile.modelConfig` and `ManagedProfileView.modelCatalogPath`.
- Produces: `PiWorkerRuntime.probe(profile)` whose `modelAvailable` is true only for an exact row of the requested provider and model ID in Pi's `--list-models` output.

- [ ] **Step 1: Write failing probe tests.** Use the existing process-runner fixture style to supply Pi table output with a header and a row for `zai glm-5.3-flash`; assert `zai/glm-5.3` is unavailable. Add the exact `zai glm-5.3` row and assert it is available when auth/resources are ready. Also assert a custom profile with missing `modelCatalogPath` cannot be marked ready. Keep a Codex/Devin fixture proving bridge behavior is unchanged. In `pi-native-auth-probe.test.ts`, use the pinned Pi CLI with a generated temporary `models.json` to show a custom model is discoverable without a live Ollama server.
- [ ] **Step 2: Verify RED.** Run `env PATH="/opt/homebrew/bin:$PATH" npx vitest run test/unit/runtime/pi-model-probe.test.ts test/integration/pi-native-auth-probe.test.ts`; the prefix-collision or custom catalog assertion should fail against the current code.
- [ ] **Step 3: Implement.** Parse non-header Pi listing rows into first provider/model columns and compare provider plus exact model ID; strip only an exact provider prefix from `profile.model`. Ensure provider registration/availability diagnostics distinguish model absence from missing auth. Verify the managed catalog path with `lstat` alongside other resources. Avoid shell parsing and model-name fuzzy matching.
- [ ] **Step 4: Document model examples.** In `docs/model-profiles.md`, provide copyable `pi-native` profile snippets using release-pinned catalog examples: DeepSeek `deepseek-v4-pro`, Gemini `gemini-3.1-pro-preview`, Z.ai GLM `glm-5.3`, MiniMax `MiniMax-M3`, Qwen Token Plan `qwen3.8-max`, Kimi `k3`, Mistral `devstral-latest`, Anthropic `claude-sonnet-4-6`, and an OpenRouter model ID selected from its catalog. Add Ollama examples for `qwen3-coder:30b`, `devstral-small-2`, and `gpt-oss:20b` using `model_config`. Explain ID/version pinning, display `name`, built-in hosted-provider `harness auth <profile>`, local dummy auth, remote `api_key_env`, workflow runner preference, and independent `family` values. Label examples opt-in and contingent on the provider's current catalog/auth; do not add them to default runners.
- [ ] **Step 5: Verify GREEN.** Run focused tests, `env PATH="/opt/homebrew/bin:$PATH" npm run verify`, and `git diff --check`. If the known Darwin process-token baseline race reappears, rerun that single test once, report both results, and do not patch unrelated process code without reproducing its cause.
- [ ] **Step 6: Commit.** Commit production, docs, and test files as `feat: document and verify coding model selection`.

## Completion check

- [ ] Confirm the spec's configuration, isolation, popular-model examples, exact preflight, and compatibility requirements each have passing test evidence.
- [ ] Report all verification results and any real-provider tests not run; no claim that uncredentialed hosted models have completed an end-to-end coding task.
