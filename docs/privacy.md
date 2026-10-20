# Privacy

What leaves your machine, and what stays on it. For protections, see the
[security model](security-model.md).

## What leaves the machine

- **Prompts and file contents go to the model provider you configured**, and
  only to it. That includes text from files and command output the agent reads,
  after [secret redaction](permissions-and-safety.md#secret-redaction). Which
  provider receives it depends on the model you choose
  ([Providers](providers.md)).
- **Webhooks**, only if you configure `webhooks`. They send a small JSON event
  (turn finished or failed, permission asked, question asked) and never
  prompts, message text, file contents or tool output
  ([Configuration](configuration.md#webhooks)).
- **HTTP hooks**, only if you add them, receive the same JSON a command hook
  gets, secret-masked ([Hooks](hooks.md#http-hooks)).
- **Update check**: at most once a day, only from a compiled release build, and
  not when `CI` is set. Where it goes depends on how YukiOshi was installed:
  GitHub (`github.com` releases feed, then `api.github.com`) for script
  installs, the npm registry for npm, yarn, pnpm and bun installs, and the
  `brew` command for Homebrew. Turn it off with `"autoupdate": false` or
  `YUKIOSHI_DISABLE_AUTOUPDATE=1` ([Installation](installation.md#automatic-updates)).
  `api.github.com` is only a fallback when the feed fails. A background
  script-install update downloads the release archive, `SHA256SUMS` and
  `SHA256SUMS.sig` from GitHub. The signature is not verified yet, because no
  release key is built in ([security model](security-model.md#the-automatic-updater)).
- **Model catalog**: a fetch from `https://models.dev/api.json` (cached for 5
  minutes, 10-second timeout). Turn it off with `YUKIOSHI_DISABLE_MODELS_FETCH`,
  or point it elsewhere with `YUKIOSHI_MODELS_URL`; each release carries an
  offline snapshot.
- **Downloads on first use**: ripgrep (from `github.com`, only when no `rg` is
  installed), and some language servers from GitHub or `download-cdn.jetbrains.com`
  (turn off with `YUKIOSHI_DISABLE_LSP_DOWNLOAD`). Provider and plugin npm
  packages come from the npm registry configured on your machine.
- **Telemetry export**: only if you set `OTEL_EXPORTER_OTLP_ENDPOINT`, logs and
  traces go to that endpoint. Not set by default.
- **Code indexing**: off by default. If you enable it with a remote embedder
  (OpenAI-compatible, Voyage), chunks of your code go to that service; Ollama
  goes to its configured URL.
- **Provider login**: `yukioshi providers login <url>` requests
  `<url>/.well-known/opencode` from the server you name, and a stored login of
  that kind makes each start fetch the same path again to load remote config.
  Some provider logins
  (GitHub Copilot, OpenAI device login) contact those providers' auth endpoints.
- **Tools you use**: `webfetch`, MCP servers, browser automation and commands
  the agent runs contact whatever they are pointed at.
- **Nothing is sent to opencode servers.** The code removes the opencode
  providers (Zen, Go) and refuses requests to `opencode.ai` and `opncd.ai`
  hosts (`packages/core/src/opencode-guard.ts`). Sharing (`/share`,
  `run --share`) and `yukioshi import <share URL>` work only with a share
  server you configure under `"enterprise"`; YukiOshi has no public share
  service ([Features](features.md)). Importing a share URL requests data from
  that URL's server; credentials are attached only when it is the configured
  server. Importing a local file contacts nothing.

No telemetry or analytics service appears in the code: a search of
`packages/*/src` found no analytics, crash-reporting or usage-tracking
destination. The destinations above are the ones found; requests made by
third-party libraries or provider SDKs to the provider you chose are not
audited here.

## What is stored locally

| Purpose        | Linux and macOS                    |
| -------------- | ---------------------------------- |
| Configuration  | `~/.config/yukioshi`               |
| Data, sessions | `~/.local/share/yukioshi`          |
| Cache          | `~/.cache/yukioshi`                |
| State          | `~/.local/state/yukioshi`          |

These follow the XDG variables. `yukioshi debug paths` prints the exact folders.
The data directory (session database, logs, credential files) is owner-only on
Linux and macOS. Credentials are in your OS keychain, or in an owner-only file
when none is available.

## Audit log

Off by default. With `"audit": { "enabled": true }` in your global config,
YukiOshi appends one JSON line per tool call, approval prompt and answer to
`<state>/audit/<date>.jsonl`. Inputs are cut to 500 characters and secrets are
masked. Nothing is sent anywhere; delete the files when you like.

## Exporting sessions

`yukioshi export` masks secrets in its output. `yukioshi export --sanitize`
also removes transcript and file data, which is safer for sharing a session
in a bug report.
