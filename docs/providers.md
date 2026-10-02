# Providers

YukiOshi Code can keep several providers configured at the same time. A model is
selected as `provider/model`, for example `openai/gpt-5` or
`anthropic/claude-sonnet-4-5`. The connection dialog intentionally presents a
small, curated subset of the bundled `models.dev` catalog.

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

### Interactive timeout policy

YukiOshi is tuned for interactive use. It waits up to 15 seconds for response
headers and up to 30 seconds between streamed chunks by default. Transient
provider failures receive at most two retries, with each retry delay capped at
10 seconds. When a provider reports sustained overload, switch to another
model or provider instead of leaving the terminal waiting for several minutes.

Providers that legitimately need longer can override the defaults:

```json
{
  "provider": {
    "google": {
      "options": {
        "headerTimeout": 30000,
        "chunkTimeout": 60000
      }
    }
  }
}
```

Set either option to `false` to disable that timeout. Full post-turn project
verification is also off by default because repository-wide test, lint, and
typecheck commands can dominate short interactions. Use `--verify` when you
want those checks run automatically.

## Curated providers

Only the following services appear in **Connect a provider**. Unselected
catalog entries and the former **Other / custom provider** item are hidden.
Environment variables are checked left-to-right.

| Display name               | Provider ID                                                 | Authentication or environment precedence                                                        |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Claude (Anthropic)         | `anthropic`                                                 | `ANTHROPIC_API_KEY`                                                                             |
| Codex (OpenAI)             | `openai`                                                    | Built-in ChatGPT Plus/Pro OAuth, or `OPENAI_API_KEY`                                            |
| Antigravity OAuth (Google) | `google`                                                    | Antigravity OAuth plugin, or `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` |
| Grok (xAI)                 | `xai`                                                       | `XAI_API_KEY`                                                                                   |
| OpenRouter                 | `openrouter`                                                | `OPENROUTER_API_KEY`                                                                            |
| AgentRouter                | `agentrouter`                                               | `AGENTROUTER_API_KEY`                                                                           |
| OpenCode                   | `opencode`                                                  | Public zero-cost models or normal OpenCode authentication                                       |
| Abacus                     | `abacus`                                                    | `ABACUS_API_KEY`                                                                                |
| Kimi                       | `kimi-code-plan-global` (older catalogs: `kimi-for-coding`) | `KIMI_API_KEY`                                                                                  |
| Moonshot AI                | `moonshotai`                                                | `MOONSHOT_API_KEY`                                                                              |
| Z.AI (GLM)                 | `zai`                                                       | `ZHIPU_API_KEY`                                                                                 |
| NVIDIA NIM                 | `nvidia`                                                    | `NVIDIA_API_KEY`                                                                                |

The picker filter is a product-level usability choice; provider metadata still
comes from models.dev. `enabled_providers` and `disabled_providers` may narrow
the curated list further.

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

### OpenCode service policy

The native `opencode` provider is displayed as **OpenCode**. Its public
zero-cost models require no local API key; paid/service-account access uses the
normal OpenCode authentication flow. OpenCode still enforces its own account,
client, quota, and eligibility policies server-side, and currently restricts
its free tier to the official OpenCode client. YukiOshi does not spoof that
client identity.

The upstream restriction is documented by an OpenCode maintainer in
[anomalyco/opencode#49590](https://github.com/anomalyco/opencode/issues/49590).
YukiOshi keeps the native provider wiring correct and transparent, but cannot
override that external service policy.

The exact model list and metadata can change when the catalog refreshes, but
the provider picker remains restricted to the IDs above.

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

## Configuration-only OpenAI-compatible endpoints

The connection dialog no longer offers an **Other** provider. For backward
compatibility, an explicit `yukioshi.json` entry can still address LM Studio,
Ollama, vLLM, LiteLLM, or another OpenAI-compatible server. Such entries do
not expand the curated connection list. Give the endpoint a unique ID and
declare each model you want to use:

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
