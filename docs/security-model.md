# Security model

This page says what YukiOshi Code trusts, what it checks, and where the
protections stop. The details of each control are in
[Permissions and safety](permissions-and-safety.md). To report a problem, see
[SECURITY.md](../SECURITY.md).

## What is trusted and what is not

- **You and your global config** are trusted. Hooks, webhooks and settings in
  `~/.config/yukioshi/yukioshi.json` always apply.
- **The model is not trusted.** It proposes commands and edits; the permission
  system decides whether they run.
- **Repository content is not trusted.** Files, project config and prompts from
  a repository can try to steer the model. A repository's config is limited
  until you run `yukioshi trust .`.
- **MCP server output is not trusted.** You configure the servers; what they
  return is masked and the server cannot extend its reach (see below).
- **The release host (GitHub) is trusted** for updates. See
  [the updater](#the-automatic-updater).

## Permission modes

| Mode       | What it really does |
| ---------- | ------------------- |
| `manual`   | Asks for anything your rules do not explicitly allow. Default. |
| `auto`     | Approves low-risk actions (reading, searching); asks for the rest. |
| `auto-all` | Approves everything that is not denied by a rule or hard-blocked. `--auto` is a shortcut for it. |
| `plan`     | Read-only. Edits, shell commands, URL fetches, skills and subagents are refused, even if an `allow` rule matches. Subagents inherit it. |
| `review`   | For unattended runs. A small model approves or refuses each action that is not low-risk, even when rules allow it. No clear answer means refused when nobody is there. |

`auto` and `auto-all` only change how prompts are answered; they do not change
actions your rules already allow. A `deny` rule always wins. Triggers
(`POST /trigger`) accept only `review` and `plan`; unattended `auto-all` is
refused. The review model can be wrong or be misled by what it reads.

## Hard blocks

Refused in every mode, whatever the rules say: file tools reading or writing
secret files (`.env`, SSH keys, `.npmrc`, credentials, anything under `.git`,
`.ssh`, `.gnupg`, `.aws`, `.kube`, and similar), and a short list of
catastrophic shell patterns (recursive delete of `/` or `~`, disk overwrite,
fork bombs, force-push or deletion of `main`, shutdown, download-to-shell
pipes). This is a backstop. The shell can still read files the file tools
refuse, such as `cat .env`.

## Repository trust

Until you run `yukioshi trust .`, a repository cannot add hooks (including HTTP
hooks), plugins, local MCP servers, LSP or formatter commands, webhooks, or
custom endpoints and headers for existing providers. Its settings can only make
YukiOshi stricter: its `allow` rules, a higher spending limit, turning off
redaction, or turning off or widening the sandbox are ignored. Trust is tied to
a fingerprint of the executable configuration, so a `git pull` that changes
it makes the repository untrusted again. Skills from a repository are
prefixed `project:`.

## OS sandbox

Off by default. When `sandbox.enabled` is true, shell commands run in
bubblewrap (Linux) or `sandbox-exec` (macOS) with writes limited to the
project, YukiOshi's folders and `writablePaths`, and `.git` read-only.
`"network": "deny"` cuts the network. If the backend is missing, shell commands
are refused rather than run unconfined. Windows has no backend, so with
`sandbox.enabled` every shell command is refused there.

The sandbox limits writing, not reading. Commands can read anything your user
can and receive YukiOshi's environment, including API keys. Hooks, local MCP
servers, language servers, formatters and webhooks run outside it. There is no
memory or process limit.

## Webfetch and private addresses

`webfetch` resolves the host and inspects every address (loopback, private,
link-local, and so on), then connects only to those addresses and re-checks
redirects. A private target asks even when rules or a saved "always" allow
`webfetch`, and the modes `auto`, `auto-all` and `review` do not answer that
prompt. Unattended runs (`yukioshi run` without `--mini`, schedules, triggers)
refuse such fetches. Only `"webfetch": { "allow_private": true }` in the global
config skips the prompt; a project config cannot set it.

## HTTP hooks

An HTTP hook is not sent to loopback, private, link-local or reserved
addresses unless `allowPrivateAddress: true` is set in the global config (it
has no effect in a project config). A repository can only add an HTTP hook
after you trust it. Credentials are written as `$NAME` in `headers` and must be
listed in `allowedEnvVars`; nothing else from the environment is read. The
sent JSON is secret-masked and warnings show only scheme and host.

## Secret redaction

On by default (`redact.enabled`). Known token formats (AWS, GitHub, OpenAI,
Anthropic, Google, Slack, Stripe live keys, private keys, JWTs, and
`password=`/`secret=`/`token=` assignments) plus your configured provider
keys and long `Bearer` tokens are masked in tool results, prompts, memory and
skills, logs, stored errors, audit entries and webhook details. Redaction is
pattern based: a secret in an unusual format is not recognised. Add your own
with `redact.patterns`. Implementation: `packages/core/src/redact.ts`.

## MCP environment isolation

A local MCP server receives only a short list of variables (`PATH`, `HOME`,
`USER`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, proxy variables) unless you
set `environment` or `inherit_env: true`. Remote servers must use `http(s)`,
and redirects to a different origin are refused so headers do not leak. Tool
names that collide with built-in tools are skipped.

## The automatic updater

At most once a day, the terminal UI and `yukioshi run` check GitHub releases
for a newer version. For script installs, newer minor and patch releases are
downloaded in the background, checked against the release's `SHA256SUMS`,
test-started with `--version`, and swapped in, keeping `yukioshi.old`. Major
releases are never installed automatically. It can be turned off with
`"autoupdate": false` or `YUKIOSHI_DISABLE_AUTOUPDATE=1`, and is skipped when
`CI` is set.

Plainly: `SHA256SUMS` comes from the same host as the binary, and the release
is not signed. The checksum detects a corrupted download, not a compromised
release host or repository account. There is no signature check yet.

## What is NOT protected

- **A malicious or misled model with `auto-all`** (or `allow` rules for `bash`)
  can run any command your user can, within only the hard blocks.
- **A user who sets `auto-all`** has chosen to approve everything not denied.
- **The sandbox is off by default**, so shell commands run unconfined, and it
  does not stop reading secrets or sending them out while network is allowed.
- **Windows** has no OS sandbox.
- **A compromised release host** (GitHub account, release assets and their
  `SHA256SUMS`) could ship a malicious update; there is no signature.
- **Trusted repositories** run their hooks, plugins and MCP servers with your
  privileges, and are outside the sandbox.
- **Redaction misses** secrets in formats it does not know.
- **Child processes after SIGKILL.** YukiOshi terminates children on
  SIGINT, SIGTERM and SIGHUP, but a process killed with SIGKILL, a crash or a
  power loss cannot run that cleanup, so children may be left running.
- **Review mode** relies on a model's judgment, which can be wrong.
- **A server with no password** on a shared machine: set
  `YUKIOSHI_SERVER_PASSWORD` for `yukioshi serve`.
