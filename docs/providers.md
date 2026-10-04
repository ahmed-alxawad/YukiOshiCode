# Providers

YukiOshi Code works with many model providers, and several can be set up at
once. Models are named `provider/model`, for example
`anthropic/claude-sonnet-4-5` or `openai/gpt-5`. Model details come from the
[models.dev](https://models.dev) catalog bundled with each release.

## Connecting a provider

```bash
yukioshi providers login     # choose a provider and a sign-in method
yukioshi providers list      # see what is connected
yukioshi providers logout    # remove a credential
```

In the terminal UI, type `/connect`. Credentials are stored in your OS
keychain (see [Permissions and safety](permissions-and-safety.md#credentials)).
You can also set a provider's environment variable instead.

These providers appear when you connect:

| Name                | Provider ID             | Sign in with                                                        |
| ------------------- | ----------------------- | ------------------------------------------------------------------- |
| Claude (Anthropic)  | `anthropic`             | `ANTHROPIC_API_KEY` or an API key                                    |
| Codex (OpenAI)      | `openai`                | ChatGPT Plus/Pro sign-in, or `OPENAI_API_KEY`                        |
| Google Gemini       | `google`                | Google AI Studio sign-in (free and paid), or `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` |
| Grok (xAI)          | `xai`                   | SuperGrok sign-in, or `XAI_API_KEY`                                  |
| OpenRouter          | `openrouter`            | `OPENROUTER_API_KEY`                                                 |
| AgentRouter         | `agentrouter`           | `AGENTROUTER_API_KEY`                                                |
| Abacus              | `abacus`                | `ABACUS_API_KEY`                                                     |
| Kimi                | `kimi-code-plan-global` | `KIMI_API_KEY`                                                       |
| Moonshot AI         | `moonshotai`            | `MOONSHOT_API_KEY`                                                   |
| Z.AI (GLM)          | `zai`                   | `ZHIPU_API_KEY`                                                      |
| NVIDIA NIM          | `nvidia`                | `NVIDIA_API_KEY`                                                     |

When a provider lists several variables, the first one that is set wins.

```bash
yukioshi models             # every model you can use now
yukioshi models anthropic   # one provider
```

## Choosing a model

YukiOshi never picks a provider or model for you. Until you choose one, the
terminal UI shows **No model selected**; pick one with `/models` and it is
remembered for next time. To set one up front, put `"model": "provider/model"`
in `yukioshi.json`, or pass `--model provider/model` to `yukioshi` or
`yukioshi run`.

`/models` lists only models that can use tools. Image, video, speech, and
embedding models cannot do an agent's work, so they are left out. If a
configured model no longer exists (for example after a provider was
removed), YukiOshi says "Model not found" and suggests close matches.

## Google

**Google Gemini (free and paid).** Choose **Sign in with Google AI Studio**.
YukiOshi shows a link instead of opening a browser, so this also works over
SSH: open the [Google AI Studio](https://aistudio.google.com/apikey) link, sign in
with your Google account, create an API key, and paste it back. AI Studio's
free tier needs no billing, with rate limits; add billing in AI Studio for
higher limits. You can also paste an existing Gemini API key.

**Google Vertex AI.** Vertex has no sign-in option in the connect list. If you
already use Vertex with the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install),
YukiOshi picks it up from your environment: sign in with
`gcloud auth application-default login` and set `GOOGLE_CLOUD_PROJECT` (and
optionally `GOOGLE_CLOUD_LOCATION`), then use `google-vertex/<model>` models.
The agent's file tools cannot read the stored Google Cloud credentials.

**Why there is no Antigravity-style sign-in.** Google's Antigravity and Gemini
CLI apps let you use your personal Google account's Gemini allowance. That
access belongs to Google's own apps: a third-party tool can only get it by
presenting itself as one of them, which Google's terms do not allow and which
has led to suspended accounts. YukiOshi does not include it. Community plugins
such as `opencode-antigravity-auth` can still be installed through the `plugin`
setting, at your own risk.

## Other providers

The catalog knows many more providers (Amazon Bedrock, Azure, Groq, Mistral,
DeepSeek, Ollama, and others). To use one, add it to the `provider` block in
`yukioshi.json`, even with no options, and provide its usual credentials:

```json
{ "provider": { "amazon-bedrock": {} } }
```

Then run `yukioshi models amazon-bedrock` to see its model names.

`enabled_providers` and `disabled_providers` narrow which providers load.

## Configuration

Provider settings go in `yukioshi.json` (see [Configuration](configuration.md)):

```json
{
  "model": "openai/gpt-5",
  "provider": {
    "openai": {
      "options": { "apiKey": "{env:OPENAI_API_KEY}" }
    }
  }
}
```

An explicit `options.apiKey` wins over environment variables. Never put a
literal key in a file you commit; use `{env:…}` or `yukioshi providers login`.
`options.baseURL` points a provider at a different endpoint.

### Timeouts

YukiOshi is tuned for interactive use: it waits up to 15 seconds for a response
to start and up to 30 seconds between streamed chunks, and retries a failing
provider at most twice, waiting no more than 10 seconds between tries. If a
provider is overloaded, switch to another model instead of waiting. Providers
that need longer can raise the limits (or set them to `false` to disable):

```json
{
  "provider": {
    "google": { "options": { "headerTimeout": 30000, "chunkTimeout": 60000 } }
  }
}
```

## Sign-in providers

### Codex (OpenAI)

ChatGPT Plus and Pro sign-in is built in, with browser and headless (device
code) options and automatic token refresh:

```bash
yukioshi providers login --provider openai --method "ChatGPT Pro/Plus (browser)"
```

On SSH or another machine without a browser, choose
`ChatGPT Pro/Plus (headless)`. An OpenAI API key is a separate option.

### Grok (xAI)

SuperGrok sign-in is built in. It uses a device code, so it works over SSH and
in containers: YukiOshi shows a web address and a short code to enter in any
browser.

```bash
yukioshi providers login --provider xai --method "SuperGrok Subscription"
```

Tokens refresh automatically. An xAI API key remains available.

### OpenCode

OpenCode's providers (OpenCode, OpenCode Zen, and OpenCode Go) are not
included: OpenCode limits them, including the free models, to the official
OpenCode client
([anomalyco/opencode#49590](https://github.com/anomalyco/opencode/issues/49590)),
and YukiOshi does not disguise itself as that client.

## Ready-made preset

An OpenAI-compatible Google AI Studio preset loads automatically when one of
its variables is set:

| Preset           | Provider ID        | Endpoint                                                   | Variables                                         |
| ---------------- | ------------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| Google AI Studio | `google-ai-studio` | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `YUKIOSHI_API_KEY` |

## Your own OpenAI-compatible server

LM Studio, Ollama, vLLM, LiteLLM, or any OpenAI-compatible server can be added
in `yukioshi.json`. Give it an ID and list its models:

```json
{
  "model": "local/qwen2.5-coder",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "api": "http://127.0.0.1:1234/v1",
      "models": { "qwen2.5-coder": { "name": "Qwen 2.5 Coder" } }
    }
  }
}
```

For a server that needs a key, add `"options": { "apiKey": "{env:MY_SERVER_KEY}" }`.
The ID is the first half of the model name, so the model above is
`local/qwen2.5-coder`.
