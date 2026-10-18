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
- **Update check**: at most once a day, a request to GitHub releases, unless
  you turn it off ([Installation](installation.md#automatic-updates)).
- **Model catalog**: a fetch from `https://models.dev/api.json`. Turn it off
  with `YUKIOSHI_DISABLE_MODELS_FETCH`, or point it elsewhere with
  `YUKIOSHI_MODELS_URL`; each release carries an offline snapshot.
- **Tools you use**: `webfetch`, MCP servers, browser automation and commands
  the agent runs contact whatever they are pointed at.
- **Nothing is sent to opencode servers.** Sharing works only with a share
  server you configure, and YukiOshi has no public share service
  ([Features](features.md)).

The docs describe no telemetry or analytics; the list
above is what the docs describe.

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
