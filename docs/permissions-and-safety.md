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

In the terminal UI, open the command palette (`ctrl+p`) and choose **Cycle
permission mode**. With `yukioshi run`, pass `--mode manual|auto|auto-all|plan`.
`--auto` is a shortcut for `auto-all`.

## Rules

Rules in `yukioshi.json` take precedence over the mode. Each tool takes
`allow`, `ask`, or `deny`, or a set of patterns:

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
`permission` block in their `agent` entry.

## Repository trust

A repository can contain configuration that makes YukiOshi run programs or send
data elsewhere: hooks, server and TUI plugins, local MCP servers, custom LSP and
formatter commands, agents to delegate to, and webhooks. Until you trust a
repository, YukiOshi loads its ordinary settings (models, rules, agents, skills)
but uses none of those, and tells you what it skipped.

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

## Reporting a security problem

Please report vulnerabilities privately; see [SECURITY.md](../SECURITY.md).
