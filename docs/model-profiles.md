# Coding model profiles (opt-in)

The shipped default workflow runs Codex CLI and Devin CLI workers and is
unchanged. The profiles below are **inactive examples**: they are not part of
any default runner preference and nothing authenticates them until you do.
Copy a snippet into `.harness/profiles.yaml`, authenticate that one profile,
and prefer it in `.harness/workflow.yaml` only if you want it used.

Each example pins a model ID that exists in the Pi catalog locked by this
release (Pi `0.86.1`). Provider catalogs change; if a provider renames or
removes an ID, preflight reports the model as missing instead of substituting
another one.

## Selecting an exact model

`provider` and `model` are the executable identity of a `pi-native` profile.
`model` accepts the provider's exact ID, including a version, snapshot,
variant, or local tag (`glm-5.3`, `qwen3-coder:30b`, `deepseek/deepseek-v4-pro`).
The `provider/` prefix on `model` is optional; when present it must equal the
profile's own `provider`.

Worker preflight requires an **exact** provider + model row in the profile's
`pi --list-models` output. `glm-5.3` is not satisfied by `glm-5.3-flash`, and a
missing credential, unreachable declaration, or absent model leaves the profile
unavailable with a specific reason — the runner then tries the next entry in
`runner.prefer`. Moving aliases such as `devstral-latest` are allowed but are a
deliberate choice to float with the provider's catalog.

`family` is the origin model family used by independent-review policy, not the
provider or gateway name. An OpenRouter-hosted DeepSeek model has
`family: deepseek`; a Devstral model has `family: mistral` regardless of which
endpoint serves it.

## Hosted provider examples

These use Pi's built-in providers, so no `model_config` is needed. Authenticate
one profile at a time:

```bash
harness auth reviewer-glm .
```

which opens an interactive Pi session inside that profile's isolated home;
complete the provider's `/login` flow there. A profile is eligible only after
preflight sees the provider registered, the exact model row, and ready
authentication.

```yaml
# .harness/profiles.yaml — add under `profiles:`
  reviewer-glm:
    family: glm
    runtime: pi
    provider: zai
    model: zai/glm-5.3
    role: review
    environment: isolated
    tools: [read, bash]
    extensions: []
    skills: []
    context_files: false
    prompt_templates: []
    mcp: []
```

The remaining hosted examples share every field above except `family`,
`provider`, `model`, and `role`; copy the block and substitute the identity:

```yaml
  implementer-deepseek:   { family: deepseek, provider: deepseek,         model: deepseek/deepseek-v4-pro,            role: implementation }
  reviewer-gemini:        { family: gemini,   provider: google,           model: google/gemini-3.1-pro-preview,       role: review }
  implementer-minimax:    { family: minimax,  provider: minimax,          model: minimax/MiniMax-M3,                  role: implementation }
  implementer-qwen:       { family: qwen,     provider: qwen-token-plan,  model: qwen-token-plan/qwen3.8-max,         role: implementation }
  implementer-kimi:       { family: kimi,     provider: kimi-coding,      model: kimi-coding/k3,                      role: implementation }
  implementer-devstral:   { family: mistral,  provider: mistral,          model: mistral/devstral-latest,             role: implementation }
  reviewer-claude:        { family: claude,   provider: anthropic,        model: anthropic/claude-sonnet-4-6,         role: review }
  implementer-openrouter: { family: deepseek, provider: openrouter,       model: openrouter/deepseek/deepseek-v4-pro, role: implementation }
```

Flow-style YAML is shown for readability; write the same keys in block style if
you prefer. Choose `role` and `tools` for the stage you intend (`review`
runners must differ in `family` from the implementer's).

## Local and OpenAI-compatible endpoints (`model_config`)

A `pi-native` profile may declare one custom OpenAI-compatible model with
`model_config`. The field is rejected on Codex, Devin, and Claude bridge
integrations and is closed: only `base_url`, `api`, `name`, and `api_key_env`
are allowed.

- `base_url`: an `http://` loopback URL (`localhost`, `*.localhost`,
  `127.0.0.0/8`, `[::1]`) or an `https://` URL. No userinfo, query, or fragment.
- `api`: `openai-completions` only for now.
- `name`: optional display name written into the generated catalog.
- `api_key_env`: optional environment variable **name**. Remote (non-loopback)
  endpoints require it; loopback endpoints may omit it.

During setup, the managed materializer generates `models.json` inside that
profile's isolated `pi-agent` home — it does not import your global Pi model
settings or any project model file. The catalog is a mode-0600 file whose
content hash is bound to the profile's receipt, and the declaration is frozen
into the resolved profile hash. Each profile gets exactly the model it
declared; rematerializing replaces the file from the declaration.

Authentication:

- Loopback without `api_key_env` (for example a local Ollama server) writes
  the non-secret literal `local` as the API key. No login or credential is
  needed.
- With `api_key_env`, the catalog stores `$NAME` — never a literal key and
  never a `!command` resolver, both of which are rejected in project YAML.
  Export the variable in your own environment before `harness setup` or a run;
  the managed environment forwards only that one declared key, and its value
  never lands in receipts or model files. If the variable is unset at launch,
  the profile is unavailable — export it and rerun setup.

### Ollama (local)

Point at the Ollama OpenAI-compatible endpoint. The tag is the exact Ollama
model ID served by your local install (`ollama pull` first):

```yaml
  implementer-ollama-qwen:
    family: qwen
    runtime: pi
    provider: ollama
    model: qwen3-coder:30b
    model_config:
      base_url: http://127.0.0.1:11434/v1
      api: openai-completions
      name: Qwen3-Coder 30B
    role: implementation
    environment: isolated
    tools: [read, bash, edit, write, grep, find, ls]
    extensions: []
    skills: []
    context_files: false
    prompt_templates: []
    mcp: []
```

Two more local examples — same block, different identity:

```yaml
  implementer-ollama-devstral: { family: mistral, provider: ollama, model: devstral-small-2,  role: implementation }
  implementer-ollama-gptoss:   { family: openai,  provider: ollama, model: gpt-oss:20b,       role: implementation }
```

### Remote OpenAI-compatible endpoint (HTTPS + `api_key_env`)

```yaml
  implementer-vllm:
    family: qwen
    runtime: pi
    provider: corp-vllm
    model: corp-vllm/qwen3-coder-32b
    model_config:
      base_url: https://llm.internal.example.com/v1
      api: openai-completions
      api_key_env: CORP_VLLM_API_KEY
    role: implementation
    environment: isolated
    tools: [read, bash, edit, write, grep, find, ls]
    extensions: []
    skills: []
    context_files: false
    prompt_templates: []
    mcp: []
```

`provider` is the catalog namespace the generated `models.json` registers; any
safe identifier works, and `model`'s `corp-vllm/` prefix (if present) names the
same provider. Export `CORP_VLLM_API_KEY` before setup — `harness auth` is not
used for `api_key_env` profiles.

## Making a profile a runner

Adding the profile does not make the workflow use it. Prefer it explicitly per
stage:

```yaml
# .harness/workflow.yaml
    - id: review
      uses: worker.review
      runner:
        prefer: [reviewer-glm, reviewer-codex, reviewer-devin]
```

The controller probes preferences in order and uses the first whose preflight
is ready, so leaving the default runners in place keeps Codex/Devin as the
fallback. The examples are opt-in conveniences, not quality endorsements:
passing configuration checks means the profile is launchable, not that the
model performs well on your tasks.
