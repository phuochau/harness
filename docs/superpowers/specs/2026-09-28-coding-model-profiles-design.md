# Coding Model Profiles — Design

**Date:** 2026-09-28
**Status:** Approved in conversation for planning and implementation with Devin CLI SWE-2 Max.

## Intent

The owner wants to experiment with familiar coding models in the existing Pi orchestration workflow, including GLM and Qwen, while choosing a provider's exact model name or version. Hosted models should use Pi's built-in providers where available. Ollama, LM Studio, vLLM, and similar OpenAI-compatible endpoints should work through an explicitly declared, isolated profile. Codex and Devin remain the default runnable workflow; additional profiles are opt-in.

## Configuration contract

`harness/profiles/v1` keeps `provider` and `model` as the executable identity. `model` accepts the exact upstream ID, including a version, snapshot, variant, or local tag (for example `glm-5.3` or `qwen3-coder:30b`). A moving provider alias is allowed when deliberately chosen. No universal `version` field is introduced because providers encode versions differently. The resolved run retains the selected provider/model string.

An optional `model_config` on a `pi-native` profile declares one custom OpenAI-compatible model under the profile's `provider` and `model`. Its fields are `base_url`, `api` (`openai-completions` initially), optional display `name`, and optional `api_key_env`. It cannot appear on Codex, Devin, or Claude bridge profiles. The resolver validates `base_url` as an HTTP loopback URL or HTTPS URL. A loopback endpoint without `api_key_env` receives Pi's non-secret dummy key; a remote endpoint requires `api_key_env`. Literal secrets and executable credential commands are not accepted from project YAML. The declared environment key is the only additional credential forwarded into that profile.

The managed profile materializer writes a Pi `models.json` generated from this validated declaration. It neither imports ambient Pi model settings nor reads arbitrary project model files. The model configuration is included in the resolved profile hash, materialized receipt, and frozen run configuration. Profiles without `model_config` preserve their existing normalized shape and hashes.

## Model examples and activation

Ship copyable, inactive examples for DeepSeek, Google Gemini, Z.ai GLM, MiniMax, Qwen, Kimi, Mistral Devstral, Anthropic Claude, and OpenRouter through `pi-native`, plus Ollama examples for Qwen3-Coder, Devstral Small, and gpt-oss. Use model IDs in the release-pinned Pi catalog where possible. The examples are documentation, not new default workflow runners or required authentication. Users select a profile in `workflow.yaml` and authenticate that managed profile before it becomes eligible. `family` remains the origin model family used by independent-review policy, not the gateway name.

## Preflight and failure behavior

Worker preflight must match the exact provider/model row from Pi's available-model listing. A similarly prefixed model (such as `glm-5.3-flash`) cannot satisfy `glm-5.3`. For a custom model, the generated catalog must be present as a regular managed file before launch. A missing credential, unavailable endpoint, absent model, or malformed declaration makes the profile unavailable with a specific reason; the controller may choose the next declared runner. Provider/model combinations are never silently substituted.

## Compatibility and verification

The default Codex/Devin profiles, workflow, package lock, source allowlist, and legacy profile hashes remain valid. No new provider package or alternate agent runtime is required. Tests cover profile validation and hash stability, managed `models.json` generation and credential forwarding, exact model matching, and initialized default compatibility. End-to-end provider quality remains an opt-in test using real credentials and local hardware; passing configuration tests is not a quality claim for every model.
