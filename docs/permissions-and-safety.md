# Permissions and safety

YukiOshi runs commands and edits files that a model proposes, so it gives you
several layers of control. From the most flexible to the strictest:

1. [Permission modes and rules](#permission-modes): what it may do without asking
2. [Repository trust](#repository-trust): whether a repository's own commands run
3. [The OS sandbox](#os-sandbox): where shell commands and edits can write
4. [Hard blocks](#hard-blocks): what is refused no matter what

Credentials are kept in your [OS keychain](#credentials).

## Permission modes

Every tool call (editing a file, running a command, fetching a URL, loading a
skill, …) is checked against your rules and the session's mode.

| Mode       | What happens                                                                |
| ---------- | --------------------------------------------------------------------------- |
| `manual`   | asks for anything your rules do not explicitly allow (the default)          |
| `auto`     | approves low-risk actions such as reading and searching; asks for the rest  |
| `auto-all` | approves everything that is not explicitly denied or hard-blocked           |
| `plan`     | allows only low-risk actions, for exploring and planning                    |
| `review`   | for unattended runs: a small model approves or refuses each action that is not low-risk |

In the terminal UI, open the command palette (`ctrl+p`) and choose **Cycle
permission mode**. With `yukioshi run`, pass `--mode manual|auto|auto-all|plan|review`.
`--auto` is a shortcut for `auto-all`.

The default rules allow most actions; YukiOshi still asks before reading
`.env` files or working outside the project, for example. Set rules (below)
for what you want to approve yourself, such as `"edit": "ask"` and
`"bash": "ask"`.

With `yukioshi run --mode`, the mode applies to every tool call: `plan` refuses
anything that is not low-risk (reading and searching), even actions your rules
allow. In the terminal UI, the mode decides how the approval prompts your rules
ask for are answered (`auto` and `auto-all` approve them, `plan` refuses the
ones that are not low-risk); actions your rules already allow are not
prompted, so the mode does not change them.

### Review mode

`review` is for runs no one watches: `yukioshi run --mode review` and
scheduled jobs added with `yukioshi schedule add … --review`. Each action that
is not low-risk (commands, edits, fetching URLs, subagents, and so on) goes to
the session's small model together with your request, even when your rules
allow it. The model allows it, or refuses it with a reason that the agent sees
so it can take another way. Reading and searching are not reviewed.

- Hard blocks and `deny` rules apply first; the reviewer never overrides them.
- If the reviewer gives no clear answer, the action is left to a person,
  which in `yukioshi run` and scheduled jobs means it is refused.
- Each reviewed action is one small-model call. Projects cannot change the
  reviewer's instructions.
- A refusal pauses a running goal, so `yukioshi run --command goal` exits
  with 3 (see [exit codes](commands.md#exit-codes)).
- A model can be wrong or be misled by what it reads, so keep the sandbox on
  and use `plan` where no changes are needed. The mode is not in the terminal
  UI's cycle.

## Rules

Rules in `yukioshi.json` take precedence over the `auto` and `auto-all`
modes, while `plan` and `review` also hold for actions the rules allow; a
`deny` rule always wins. Each tool takes `allow`, `ask`, or `deny`, or a set of
patterns:

```json
{
  "permission": {
    "edit": "ask",
    "bash": { "*": "ask", "git push *": "deny", "npm test": "allow" },
    "webfetch": "allow",
    "skill": "ask"
  }
}
```

Patterns are checked in order and **the last match wins**, so put the catch-all
`*` first and the specific patterns after it. Agents can carry their own
`permission` block in their `agent` entry. Browser automation tools (`browser_browser_navigate`,
`browser_browser_snapshot`, `browser_browser_click`, and other tools provided by the `browser` MCP server)
follow the permission rules like other MCP tools (for example, `"browser_browser_*": "ask"`).

## Repository trust

A repository can contain configuration that makes YukiOshi run programs or send
data elsewhere: hooks, server and TUI plugins, browser automation, local MCP servers, custom LSP and
formatter commands, agents to delegate to, webhooks, enterprise and auto-sharing,
remote skills and instructions URLs, remote MCP headers, and custom commands
whose template runs shell commands (`!`…``, which would run when you use the
command, even one named like a built-in such as `/init`).

Crucially, an untrusted repository cannot change where your model requests go or
what credentials accompany them. Until you trust a repository:
- Custom endpoints and headers on existing providers (such as `provider.<id>.api`,
  `provider.<id>.options.baseURL`, `options.headers`, and API keys) are ignored,
  and the global or default provider endpoint is used.
- Providers defined only by the project (that do not exist globally or in models.dev)
  are ignored entirely, because their address is the whole point of them. Local-model
  projects (such as Ollama, vLLM, or LM Studio) need `yukioshi trust .` once.

- A repository's settings can make YukiOshi stricter but never looser: its `allow`
  permission rules, a higher spending limit than yours, turning off or
  allow-listing secret redaction, turning the sandbox off or widening it,
  provider `npm` packages, `shell` (the program every command runs in), turning
  `snapshot` (undo) off, `references` (other repositories to fetch), and
  instruction files outside the project (absolute, `~` or `..` paths) are ignored.

YukiOshi loads safe settings (model names, limits, timeouts, local skills) but uses
none of the restricted or executable features, and reports each skipped entry.

```bash
yukioshi trust .            # trust the repository you are in
yukioshi trust . --status   # check
yukioshi trust . --revoke   # take trust back
```

Trust is stored outside the repository and is tied to its content: YukiOshi
records a fingerprint of the executable configuration (the `hooks`, `plugin`,
`mcp`, `lsp`, and `formatter` settings, the files under `.yukioshi/` and
`.opencode/`, and the scripts those settings point to). If any of that changes,
for example after a `git pull` or when you review a pull request with
`yukioshi pr`, the repository becomes untrusted again and `--status` reports
that it changed. Review the change, then run `yukioshi trust .` again. Editing
ordinary settings such as `model` does not affect trust.

Skills from a repository are always available, but under a `project:` prefix
(for example `project:deploy`), so a repository cannot replace a built-in or
personal skill.

## OS sandbox

Off by default. When enabled, every shell command runs inside the operating
system's sandbox: bubblewrap on Linux (install the `bubblewrap` package) and
`sandbox-exec` on macOS.

```json
{ "sandbox": { "enabled": true, "network": "deny", "writablePaths": ["~/.cache/my-tool"] } }
```

- Only the project, YukiOshi's own folders, and `writablePaths` are writable.
  Entries may start with `~`; relative entries are resolved from the project
  root.
- `.git` folders stay read-only.
- `"network": "deny"` cuts network access for sandboxed commands; the default
  is `"allow"`.
- YukiOshi's file-editing tools (`edit`, `write`, and `apply_patch`) are held
  to the same boundary.
- YukiOshi's own configuration, state (project trust, audit log, schedules),
  installed binaries and credentials stay read-only, even though they are
  YukiOshi's folders, so a command cannot turn the sandbox off or pre-approve
  itself. List one in `writablePaths` to opt it back in.

What the sandbox does not do:

- It restricts writing, not reading. Commands can read any file your user can,
  including `~/.ssh`, and they receive YukiOshi's environment variables,
  including API keys. With the default `"network": "allow"` they can send what
  they read anywhere.
- Only the shell command is sandboxed. Hooks, local MCP servers, language
  servers, formatters, and webhooks run outside it.
- On Linux, host unix sockets for D-Bus, Docker, SSH agents, and tmux are
  hidden, but other sockets you keep in your home directory are not. On
  `"network": "allow"` the command shares the host's network, including
  abstract sockets.
- `/tmp` is the host's and read-only except `/tmp/yukioshi`.
- There is no memory or process limit; a command ends at its timeout (two
  minutes by default).

## MCP servers

You configure MCP servers, but what they return is not trusted. YukiOshi
applies these checks:

- A remote server URL must start with `http://` or `https://`. Other schemes
  (such as `file:`) are refused and the server is reported as failed. A
  non-local `http://` URL is allowed but logged as a warning, because headers
  and tokens go out unencrypted. `localhost`, `*.localhost`, `127.x.x.x`, and
  `::1` do not trigger the warning.
- A remote server cannot send your configured headers elsewhere. YukiOshi
  follows its redirects (up to five) only within the original origin and
  refuses a redirect to a different origin.
- A tool is named `<server>_<tool>`. A tool whose name matches a built-in tool
  (a server `apply` with a tool `patch` would match `apply_patch`) or
  `tool_search` is skipped and logged. If two tools get the same name after
  sanitizing, the server that sorts first by name keeps it and the later tool
  is skipped.
- A tool call that keeps reporting progress is stopped after 30 minutes. The
  per-call timeout otherwise restarts on each progress message.
- Tool results and error messages are masked as described under
  [secret redaction](#secret-redaction) before they are shortened, saved, or
  shown to the model. The full text that is written to a file when a long
  result is cut off is masked too.
- A server's instructions are put in the system prompt inside
  `<mcp_instructions>` and `<server>` elements. Text in them that looks like an
  opening or closing `<server` or `<mcp_instructions` tag is altered, so the
  server cannot close the wrapper and continue as prompt text.

## Hard blocks

These are refused in every mode and cannot be overridden by any rule. They are
a backstop against obvious disasters, not a replacement for the sandbox and
your rules.

**File tools** (`read`, `edit`, `write`, `apply_patch`) refuse secret files:

- `.env` and `.env.*`, except templates ending in `.example`, `.sample`,
  `.template`, or `.dist`;
- SSH keys, `.npmrc`, `.netrc`, credentials files, certificates, and key files;
- anything under `.git`, `.ssh`, `.gnupg`, `.aws`, or `.kube`;
- Google Cloud sign-in files (`application_default_credentials.json` and
  gcloud's stored credentials);
- shell startup files such as `~/.bashrc`, `~/.zshrc`, and `~/.profile` when
  they are outside the project.

**Shell commands** are refused only for catastrophic patterns: recursive
deletion of `/`, `~`, `$HOME`, `*`, or `.`; formatting or overwriting a disk;
fork bombs; force-pushing or deleting `main`, `master`, or `trunk`; and running
`shutdown`, `reboot`, `halt`, or `poweroff`. Ordinary commands that merely
mention those words, such as `grep -rn shutdown src`, are allowed.

The shell itself can still read files the file tools refuse (for example
`cat .env`). Use permission rules and the sandbox to control the shell.

## Credentials

API keys and sign-in tokens are stored in your operating system's keychain:

| System  | Store                                          |
| ------- | ---------------------------------------------- |
| macOS   | Keychain (`security`)                          |
| Linux   | Secret Service, such as GNOME Keyring or KWallet (`secret-tool`) |
| Windows | DPAPI, protected for your user account         |

Secrets are passed to those tools on standard input, never as command-line
arguments. Where no keychain is available (for example on a server without a
desktop session), YukiOshi falls back to a file only your user can read. Set
`YUKIOSHI_DISABLE_KEYCHAIN=1` to always use that file.

On Linux and macOS the data directory (session database, logs, and credential
files) is created with owner-only permissions (`0700`), and YukiOshi sets that
mode on an existing directory at start-up. Credential files are created with
mode `0600` from the start, so they are never readable by others, even briefly.

## Secret redaction

YukiOshi masks unmistakable secrets before anything is sent to the model provider. Redaction is on by default (`redact: { enabled: true }`).

### What is masked
- **AWS access keys and secret keys**: `AKIA...`, `ASIA...`, and `aws_secret_access_key` / `AWS_SECRET_ACCESS_KEY` assignments (`[REDACTED:aws-key]`, `[REDACTED:aws-secret-key]`).
- **GitHub tokens**: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, and `github_pat_` (`[REDACTED:github-token]`).
- **API keys**: OpenAI (`sk-`), Anthropic (`sk-ant-`), and Google (`AIza`) (`[REDACTED:openai-key]`, `[REDACTED:anthropic-key]`, `[REDACTED:google-key]`).
- **Slack tokens**: `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-` (`[REDACTED:slack-token]`).
- **Stripe live keys**: `sk_live_`, `rk_live_` (`[REDACTED:stripe-key]`).
- **Private keys**: `-----BEGIN ... PRIVATE KEY-----` blocks (`[REDACTED:private-key]`).
- **JWTs**: JSON Web Tokens with standard headers (`[REDACTED:jwt]`).
- **Environment variables**: `password=`, `secret=`, `token=` assignments (`[REDACTED:password]`, `[REDACTED:secret]`, `[REDACTED:token]`).

Normal code identifiers (such as `sk-` inside an unrelated word or Stripe test keys) are never matched.

### Where redaction applies
- **Tool results**: file contents read, grep results, bash output, webfetch, MCP tool responses, and delegate agent outputs before they are saved to session history or sent to the model.
- **User prompts**: secrets pasted or typed into prompts are masked before leaving the machine for the model; your local message history remains intact, and a notification warns that secrets were masked.
- **Persistent memory and skills**: secrets are masked before `memory_save` or `skill_save` writes them to disk.
- **File editing**: when the agent edits a file containing a secret, `edit` resolves the placeholders back to real secrets, ensuring `[REDACTED:...]` is never written back to your files.

### Provider keys

YukiOshi also remembers the API keys of the providers it uses (at least 8
characters). Where it scrubs text, those exact values are replaced with
`[REDACTED:provider-key]`, even when a key matches none of the formats above,
such as a key for a custom gateway. Any `Bearer <token>` of 16 or more
characters becomes `Bearer [REDACTED:bearer-token]`. A provider can echo the
`Authorization` header back in an error, so this applies to:
- the log files;
- errors stored with a session, and so also in exports and printed output;
- audit log entries and webhook details.

### Configuration

```jsonc
{
  "redact": {
    "enabled": true,
    // Values that should never be masked
    "allow": ["my-harmless-token"],
    // Additional custom regular expressions to mask
    "patterns": ["MY_CUSTOM_SECRET_[A-Za-z0-9]+"]
  }
}
```

## Audit log

A local record of what the agent did, for you or your team to review later. It
is off by default; turn it on in your own global config
(`~/.config/yukioshi/yukioshi.json` on Linux and macOS, or `%APPDATA%\yukioshi\yukioshi.json` on Windows):

```json
{ "audit": { "enabled": true } }
```

YukiOshi then appends one JSON line for each tool call, approval prompt, and
answer to `<state>/audit/<date>.jsonl` (`~/.local/state/yukioshi/audit/<date>.jsonl` on Linux and macOS, or `%LOCALAPPDATA%\yukioshi\audit\<date>.jsonl` on Windows):

```json
{"time":"2026-10-07T09:12:03.120Z","directory":"/home/me/app","event":"tool","session":"ses_…","tool":"bash","status":"completed","input":"npm test"}
{"time":"2026-10-07T09:12:09.481Z","directory":"/home/me/app","event":"permission.asked","session":"ses_…","permission":"bash","patterns":["git push"]}
{"time":"2026-10-07T09:12:15.002Z","directory":"/home/me/app","event":"permission.replied","session":"ses_…","reply":"reject"}
```

- A tool call is recorded with the part of its input that says what it did
  (the command, file, URL, or search pattern), shortened to 500 characters.
- Secrets in what is recorded are masked, as for [redaction](#secret-redaction), including your provider keys.
- Only the global config counts: a project's own config cannot turn the log on
  or off.
- Nothing is sent anywhere. On Linux and macOS the audit directory and log files
  are created with owner-only file permissions (`0700` and `0600`), readable only by
  you; on Windows the files inherit the permissions of the user's profile folder
  (`%LOCALAPPDATA%`). YukiOshi keeps them until you delete them; `yukioshi uninstall`
  removes them along with other state files.

## The headless server

`yukioshi serve` takes a password from `YUKIOSHI_SERVER_PASSWORD` (and a user
name from `YUKIOSHI_SERVER_USERNAME`). Set one if anyone else can reach the
port.

- The user name and password are compared in constant time. Both are always
  checked, so a wrong user name cannot be told apart from a wrong password by
  timing.
- When no password is set and the server is bound to a loopback address
  (`localhost`, `127.x.x.x`, or `::1`), a request whose `Host` header is not a
  `localhost` name, an IP address, or a host from `--cors` is refused with 403.
  This stops a web page on a hostile domain that resolves to `127.0.0.1` (DNS
  rebinding) from using the server. With a password set this check is off, so a
  reverse proxy that rewrites `Host` keeps working.
- A request other than `GET`, `HEAD`, or `OPTIONS` that carries an `Origin`
  header from a disallowed origin is refused with 403, with or without a
  password. Allowed origins are the server's own host, `localhost` and
  `127.0.0.1` on any port, YukiOshi's desktop app, `yukioshi.com` and
  `opencode.ai` sites, and anything you pass with `--cors`. Clients that send
  no `Origin` header, such as the CLI, the SDK, or `curl`, are not affected.

## Triggers and unattended runs

The `POST /trigger` endpoint on `yukioshi serve` accepts HTTP requests to start unattended runs in designated directories. Because triggered runs may be invoked from external systems or webhook handlers, YukiOshi enforces strict security boundaries:

- **Token scope isolation**: The trigger bearer token provides access strictly to `POST /trigger`. It cannot authenticate any other endpoint on the server. Conversely, `YUKIOSHI_SERVER_PASSWORD` does not grant access to `POST /trigger`.
- **Constant-time comparison**: Token verification computes SHA-256 digests and compares them using `crypto.timingSafeEqual` to protect against timing attacks. Tokens must be at least 32 characters long.
- **Untrusted prompts & restricted modes**: Prompts sent to `POST /trigger` may come from external or untrusted sources. Therefore, triggers only support `"review"` (default, where a small model evaluates and approves/rejects non-low-risk actions) or `"plan"` (read-only exploration) modes. Unattended `"auto-all"` is prohibited and refused.
- **Directory boundary**: Triggers can only run in directories explicitly enumerated in `triggers.directories` within the user's global configuration (`~/.config/yukioshi/yukioshi.json` on Linux/macOS, `%APPDATA%\yukioshi\yukioshi.json` on Windows). Project configurations cannot enable triggers or expand the directory list.
- **Payload limits**: Request bodies are capped at 64 KB and strictly validated to reject unknown fields.
- **Concurrency locking**: Only one run per directory may execute at any given time. Concurrent attempts return HTTP 409 Conflict until the active run finishes.
- **Audit logging**: When audit logging is enabled (`audit.enabled`), every accepted trigger event is logged to the local audit trail with session ID, directory, mode, and masked prompt.

## Reporting a security problem

Please report vulnerabilities privately; see [SECURITY.md](../SECURITY.md).

