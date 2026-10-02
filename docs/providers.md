# Providers

YukiOshi Code can keep several providers configured at the same time. A model is
selected as `provider/model`, for example `openai/gpt-5` or
`anthropic/claude-sonnet-4-5`. Provider and model names come from the bundled
`models.dev` catalog plus any entries in your `yukioshi.json`.

## Configuration

Put provider settings in `yukioshi.json` (normally in your project or in the
user config directory). Existing `opencode.json` files remain supported and
have lower precedence when both names exist at the same location:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-5",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "{env:OPENAI_API_KEY}"
      }
    }
  }
}
```

`{env:NAME}` is expanded when the configuration is read. For a provider with
catalog metadata, YukiOshi Code checks the provider's `env` list in order and
uses the first non-empty variable. An explicit `provider.<id>.options.apiKey`
wins over automatic environment discovery. In the examples below, the
explicit `apiKey` is optional; it is shown when it makes the precedence clear.
Do not commit literal API keys to `yukioshi.json`.

You can also set a provider's `options.baseURL` when an endpoint needs a
custom URL. A configured provider may define models explicitly:

```json
{
  "model": "gateway/my-model",
  "provider": {
    "gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://gateway.example/v1",
        "apiKey": "{env:GATEWAY_API_KEY}"
      },
      "models": {
        "my-model": {
          "name": "My model"
        }
      }
    }
  }
}
```

## YukiOshi-compatible presets

These presets use the shared OpenAI-compatible provider adapter. The listed
environment variables are tried left-to-right.

| Provider ID | Preset | Default base URL | API-key precedence |
| --- | --- | --- | --- |
| `google-ai-studio` | Google AI Studio through its OpenAI-compatible endpoint | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GOOGLE_API_KEY`, then `GEMINI_API_KEY`, then `YUKIOSHI_API_KEY` |
| `opencode-zen` | OpenCode Zen | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY`, then `YUKIOSHI_API_KEY` |

The Google AI Studio preset is separate from the native `google` Gemini provider; use
`google/<model>` for the native Google SDK and `google-ai-studio/<model>` for
the OpenAI-compatible endpoint. The `opencode-zen` API-key preset deliberately
contains only paid models. OpenCode's zero-cost models are exposed only as
`opencode/<model>` so they cannot be accidentally sent under the wrong
provider identity. If an older session saved a free model as
`opencode-zen/<model>`, open `/models` and select the corresponding
`opencode/<model>` entry once; the corrected selection is then persisted.

## Catalog-backed providers

The following provider IDs are built into this fork and use their native AI
SDK or a provider-specific adapter. For each row, the environment variables
are checked in the displayed order by the `models.dev` catalog. Most users
only need to export the first variable and select a model; the explicit
`options.apiKey` form works for all providers that accept an API key.

| Provider ID | Service | Environment-variable precedence |
| --- | --- | --- |
| `openai` | OpenAI Responses API | `OPENAI_API_KEY` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` |
| `nvidia` | NVIDIA NIM | `NVIDIA_API_KEY` |
| `anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `google` | Google Gemini API | `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` |
| `mistral` | Mistral | `MISTRAL_API_KEY` |
| `groq` | Groq | `GROQ_API_KEY` |
| `deepinfra` | DeepInfra | `DEEPINFRA_API_KEY` |
| `togetherai` | Together AI | `TOGETHER_API_KEY` |
| `cohere` | Cohere | `COHERE_API_KEY` |
| `perplexity` | Perplexity | `PERPLEXITY_API_KEY` |
| `xai` | xAI | `XAI_API_KEY` |
| `alibaba` | Alibaba DashScope | `DASHSCOPE_API_KEY` |
| `cerebras` | Cerebras | `CEREBRAS_API_KEY` |
| `venice` | Venice AI | `VENICE_API_KEY` |
| `zenmux` | ZenMux | `ZENMUX_API_KEY` |
| `llmgateway` | LLM Gateway | `LLMGATEWAY_API_KEY` |
| `kilo` | Kilo Gateway | `KILO_API_KEY` |
| `vercel` | Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| `gitlab` | GitLab Duo | `GITLAB_TOKEN` |
| `github-copilot` | GitHub Copilot | `GITHUB_TOKEN` |
| `sap-ai-core` | SAP AI Core | `AICORE_SERVICE_KEY` |

For example, native Anthropic setup can be as small as:

```json
{
  "model": "anthropic/claude-sonnet-4-5"
}
```

with `ANTHROPIC_API_KEY` exported in the environment. To make the source
explicit in a checked-in config, use:

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

### Cloud, enterprise, and authenticated providers

These providers need more than one credential or a non-key authentication
flow:

| Provider ID | Required setup and precedence |
| --- | --- |
| `amazon-bedrock` | Uses the AWS credential chain. Catalog variables are checked as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, then `AWS_BEARER_TOKEN_BEDROCK`; AWS profiles, roles, and workload identity can also supply credentials. |
| `google-vertex` | Uses Google ADC rather than an API key. Project is resolved from `GOOGLE_VERTEX_PROJECT`, then `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, or `GCLOUD_PROJECT`; location from `GOOGLE_VERTEX_LOCATION`, `GOOGLE_CLOUD_LOCATION`, or `VERTEX_LOCATION` (default `us-central1`). Authenticate with `gcloud auth application-default login` or a service-account credential via `GOOGLE_APPLICATION_CREDENTIALS`. |
| `google-vertex-anthropic` | Same Google Vertex ADC setup as above, for Anthropic models hosted on Vertex, but the project env var precedence differs: `GOOGLE_CLOUD_PROJECT`, then `GCP_PROJECT`, then `GCLOUD_PROJECT` (note: `GOOGLE_VERTEX_PROJECT` is not checked for this variant). |
| `azure` / `azure-cognitive-services` | Configure the Azure resource/deployment settings in the provider options and use the Azure credential expected by that deployment; the provider's config options take precedence over defaults. |
| `cloudflare-ai-gateway` | `CLOUDFLARE_API_TOKEN` (or `CF_AIG_TOKEN`) — required for authenticated gateways; `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID` also required to identify the gateway. All three are mandatory; the order listed is not a fallback chain. |
| `cloudflare-workers-ai` | `CLOUDFLARE_ACCOUNT_ID`, then `CLOUDFLARE_API_KEY`. |
| `snowflake-cortex` | `SNOWFLAKE_ACCOUNT`, then `SNOWFLAKE_CORTEX_TOKEN` (or `SNOWFLAKE_CORTEX_PAT`); the account is also used to form the default Cortex URL. |
| `opencode` | Native OpenCode provider, displayed as **OpenCode** in YukiOshi. Its public zero-cost models require no local API key; paid/service-account access uses the normal OpenCode authentication flow. OpenCode still enforces its own account, client, quota, and eligibility policies server-side, and currently restricts its free tier to the official OpenCode client. YukiOshi does not spoof that client identity. |

The upstream restriction is documented by an OpenCode maintainer in
[anomalyco/opencode#49590](https://github.com/anomalyco/opencode/issues/49590).
YukiOshi keeps the native provider wiring correct and transparent, but cannot
override that external service policy.

The exact model list and provider metadata can change with the catalog. If a
provider is present in the model picker but is not listed above, its
`models.dev` `env` list is authoritative: the first non-empty variable wins,
and an explicit `provider.<id>.options.apiKey` overrides that discovery.

## OAuth providers

### OpenAI Codex / ChatGPT

Codex OAuth is built in. It supports browser and headless device login, token
refresh, the ChatGPT account header, and the Codex Responses endpoint. Start
the browser flow with:

```sh
yukioshi auth login --provider openai --method "ChatGPT Pro/Plus (browser)"
```

For SSH or another headless environment, select `ChatGPT Pro/Plus (headless)`
instead. After login, choose one of the OAuth-enabled `openai/<model>` entries.
An OpenAI API key remains a separate login method.

### Google Antigravity

YukiOshi can host an OpenCode-compatible Antigravity OAuth plugin under the
native `google` provider. Authentication methods from multiple Google plugins
are merged, so an Antigravity OAuth option is not hidden by another Google
credential plugin. Example opt-in configuration:

```json
{
  "plugin": ["opencode-antigravity-auth@latest"]
}
```

Then run:

```sh
yukioshi auth login --provider google --method "OAuth with Google (Antigravity)"
```

Antigravity OAuth plugins are third-party integrations, not bundled Google or
YukiOshi components. Some implementations reuse IDE credentials or private
service endpoints, which may be unsupported by Google and may put an account
at risk. Review the selected plugin and Google's current terms before enabling
it. The supported first-party alternatives are the native `google` provider
with a Gemini API key, Google Vertex through ADC, or Google's official `agy`
client.

## Generic OpenAI-compatible endpoints

Use a custom provider entry for LM Studio, Ollama, vLLM, LiteLLM, or another
server implementing the OpenAI-compatible API. Give it a unique provider ID,
set the endpoint, and declare each model you want to use:

```json
{
  "model": "local/qwen2.5-coder",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "api": "http://127.0.0.1:1234/v1",
      "models": {
        "qwen2.5-coder": {
          "name": "Qwen 2.5 Coder"
        }
      }
    }
  }
}
```

For a server requiring a key, add an `options.apiKey` reference and use the
server's base URL in `api` (or `options.baseURL`):

```json
{
  "provider": {
    "vllm": {
      "npm": "@ai-sdk/openai-compatible",
      "api": "https://vllm.example/v1",
      "options": {
        "apiKey": "{env:VLLM_API_KEY}"
      },
      "models": {
        "my-model": { "name": "My model" }
      }
    }
  }
}
```

The custom provider ID becomes the first half of the model name, so the model
above is selected with `vllm/my-model`. The generic adapter does not invent an
environment-variable name: put the key in `options.apiKey`, and put any
provider-specific headers in the model or provider options supported by your
configuration.
