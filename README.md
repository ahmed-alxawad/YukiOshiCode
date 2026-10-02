<p align="center">
  <img src="assets/brand/yukioshi-code-wordmark-light.png" alt="YukiOshi Code" width="900">
</p>

<p align="center">
  <strong>An AI coding agent for the terminal.</strong><br>
  Bring any model, keep control of what it can do, and see the evidence before you accept the work.
</p>

<p align="center">
  <a href="https://github.com/ahmed-alxawad/YukiOshiCode/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/ahmed-alxawad/YukiOshiCode?label=release"></a>
  <a href="https://github.com/ahmed-alxawad/YukiOshiCode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ahmed-alxawad/YukiOshiCode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: proprietary" src="https://img.shields.io/badge/license-proprietary-lightgrey"></a>
</p>

---

YukiOshi Code (`yukioshi`) is a terminal coding agent built on the Bun and
Effect-TS architecture of [opencode](https://github.com/anomalyco/opencode).
It reads and edits your code, runs commands, and works through multi-step
tasks with whichever model provider you choose, while permission modes, an
OS-level sandbox, and hard safety blocks keep it inside the limits you set.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Models and providers](#models-and-providers)
- [Permission modes](#permission-modes)
- [Safety](#safety)
- [Features](#features)
- [Configuration](#configuration)
- [Hooks](#hooks)
- [Skills](#skills)
- [Commands](#commands)
- [Development](#development)
- [License and attribution](#license-and-attribution)

## Install

**macOS and Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/ahmed-alxawad/YukiOshiCode/main/install | bash
```

The script detects your OS, CPU, and libc (glibc or musl, AVX2 or baseline),
downloads the matching binary from the
[latest release](https://github.com/ahmed-alxawad/YukiOshiCode/releases/latest)
into `~/.yukioshi/bin`, and adds that directory to your shell's `PATH`.

```bash
# A specific version
curl -fsSL https://raw.githubusercontent.com/ahmed-alxawad/YukiOshiCode/main/install | bash -s -- --version 0.3.0

# Install without touching shell config files
curl -fsSL https://raw.githubusercontent.com/ahmed-alxawad/YukiOshiCode/main/install | bash -s -- --no-modify-path
```

**Windows, or manual install**: download the archive for your platform from
the [releases page](https://github.com/ahmed-alxawad/YukiOshiCode/releases),
extract it, and put `yukioshi` (`yukioshi.exe` on Windows) on your `PATH`.

Each release has a single self-contained binary for Linux (x64, arm64, glibc
and musl), macOS (Apple Silicon and Intel), and Windows (x64, arm64). Nothing
else needs to be installed.

Keep it current with `yukioshi upgrade`, and remove it with
`yukioshi uninstall`.

## Quick start

```bash
cd your-project
yukioshi providers login   # pick a provider and sign in or paste an API key
yukioshi                   # open the terminal UI in this directory
```

In the TUI, describe the task in plain language. Type `/` to see the slash
commands (including every skill), and `@` to attach a file.

For scripts and CI, `run` sends one message and streams the result:

```bash
yukioshi run "explain what src/server does"
yukioshi run -m anthropic/claude-sonnet-4-5 --mode auto "fix the failing test in test/api.test.ts"
yukioshi run --format json "list the TODO comments" > events.jsonl
yukioshi run -c "now add a test for it"   # continue the last session
```

## Models and providers

Models are addressed as `provider/model`, and several providers can be
configured at the same time. The provider list comes from the bundled
[models.dev](https://models.dev) catalog, so most providers work by setting
their usual environment variable or running `yukioshi providers login`.

| Provider                 | How to connect                                                       |
| ------------------------ | -------------------------------------------------------------------- |
| Anthropic                | `ANTHROPIC_API_KEY`                                                  |
| OpenAI                   | `OPENAI_API_KEY`, or ChatGPT / Codex sign-in (`yukioshi providers login`) |
| Google AI Studio         | `GOOGLE_API_KEY` or `GEMINI_API_KEY`                                 |
| OpenRouter               | `OPENROUTER_API_KEY`                                                 |
| NVIDIA NIM               | `NVIDIA_API_KEY`                                                     |
| OpenCode / OpenCode Zen  | free OpenCode models, or `OPENCODE_API_KEY` for Zen                  |
| Amazon Bedrock, Azure, Vertex, Groq, Mistral, DeepSeek, xAI, Ollama, … | standard credentials from the catalog |
| Any OpenAI-compatible endpoint | a `provider` entry with `baseURL` in `yukioshi.json`           |

```bash
yukioshi models            # list every model you can use right now
yukioshi models openai     # just one provider
yukioshi providers list    # show stored credentials
```

Credential precedence, OAuth, custom endpoints, and timeouts are covered in
[docs/providers.md](docs/providers.md).

## Permission modes

Every tool call (edit a file, run a command, fetch a URL, load a skill, …) is
checked against your `permission` rules and the session's mode:

| Mode       | Behaviour                                                                    |
| ---------- | ---------------------------------------------------------------------------- |
| `manual`   | Asks for anything your config does not explicitly allow.                     |
| `auto`     | Approves low-risk actions such as reads and searches; asks for the rest.     |
| `auto-all` | Approves everything that is not explicitly denied or hard-blocked.           |
| `plan`     | Restricts the agent to low-risk actions, for exploring and planning safely.  |

In the TUI, choose **Cycle permission mode** from the command palette
(`ctrl+p`). With `yukioshi run`, pass `--mode`. Rules in
`yukioshi.json` take precedence over the mode:

```json
{
  "permission": {
    "edit": "ask",
    "bash": { "git push *": "deny", "npm test": "allow", "*": "ask" },
    "webfetch": "allow"
  }
}
```

## Safety

- **Hard blocks.** Some actions are refused in every mode, whatever the
  config says. That covers secret files (`.env*`, SSH keys, `.npmrc`,
  `.netrc`, certificates, and anything under `.git`, `.ssh`, `.gnupg`, `.aws`,
  or `.kube`) and irreversible commands such as recursive deletion of the
  filesystem root, disk-level writes, fork bombs, and force-pushing or
  deleting protected branches.
- **OS sandbox** (off by default). With `sandbox.enabled`, every shell command
  runs under bubblewrap (Linux) or `sandbox-exec` (macOS). Only the workspace,
  YukiOshi's own data directories, and paths you add to
  `sandbox.writablePaths` are writable, `.git` is protected, and
  `sandbox.network: "deny"` cuts network access. The `write` and `edit` tools
  enforce the same boundary.

  ```json
  { "sandbox": { "enabled": true, "network": "deny", "writablePaths": ["~/.cache/my-tool"] } }
  ```

- **Repository trust.** A repository's declarative config (models, rules,
  agents) loads normally, but its shell hooks, server plugins, and TUI plugins
  do not run until you trust it. Trust is stored outside the repository.

  ```bash
  yukioshi trust .            # trust the current repository
  yukioshi trust . --status
  yukioshi trust . --revoke
  ```

- **Credentials in the OS keychain.** API keys and OAuth tokens are stored
  with macOS Keychain, the Secret Service (`secret-tool`) on Linux, or DPAPI on
  Windows. Secrets are passed to those tools on stdin, never as arguments.
  Where no keychain is available, YukiOshi falls back to a file readable only
  by you. Set `YUKIOSHI_DISABLE_KEYCHAIN=1` to always use the file.

## Features

**Evidence-based verification.** When a turn changes source files, the TUI
discovers the project's own `typecheck`, `lint`, and `test` commands and
reports the result as verified, partially verified, failed, unavailable, or
skipped. Documentation- and config-only edits get lightweight checks only.
Override the detected commands with `YUKIOSHI_VERIFY_TEST_CMD`,
`YUKIOSHI_VERIFY_TYPECHECK_CMD`, `YUKIOSHI_VERIFY_LINT_CMD`, or a single
`YUKIOSHI_VERIFY_COMMAND`. Turn it off with `YUKIOSHI_SKIP_VERIFY=1`.

**Project memory** (`memory.enabled`). Adds `memory_recall` and
`memory_save`, so the agent can keep durable project facts, environment
notes, and corrections across sessions. Memory is stored as plain Markdown in
YukiOshi's data directory, one set per repository. Reading is low-risk;
saving asks for permission in `auto` mode.

**Semantic code search** (`indexing.enabled`). Adds `code_search`, backed by
an embedding index of your repository with symbol-aware chunking for about
25 languages. Embeddings can come from OpenAI, Ollama, any OpenAI-compatible
server, Gemini, Mistral, Vercel AI Gateway, Bedrock, OpenRouter, or Voyage,
and vectors are stored in an embedded LanceDB database or a Qdrant server.
`.yukioshiignore` excludes files.

```json
{
  "indexing": {
    "enabled": true,
    "provider": "ollama",
    "model": "nomic-embed-text",
    "ollama": { "baseUrl": "http://localhost:11434" }
  }
}
```

**Code graph** (`code_graph.enabled`). Adds a read-only `code_graph` tool that
answers structural questions (who calls what, how modules connect) from a
Graphify graph at
`graphify-out/graph.json`, with a local fallback when no graph exists.

**Parallel subagents.** The `task` tool delegates work to a subagent. With
`YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS=1`, `task_parallel` runs up to eight
subagents (four at a time), each optionally in its own git worktree.

Code search and code-graph results are retrieval hints, not ground truth: the
agent still reads the files and runs the checks before it treats a change as
done.

**Also included:** MCP servers (`mcp`), custom agents (`agent`), custom slash
commands, LSP diagnostics, automatic formatters, context compaction for long
sessions, session export/import, and a headless server (`yukioshi serve`)
that other clients can attach to.

## Configuration

YukiOshi reads `yukioshi.json` or `yukioshi.jsonc`. Later sources override
earlier ones:

1. Global config: `~/.config/yukioshi/yukioshi.json`
2. A file named by `YUKIOSHI_CONFIG`
3. `yukioshi.json` in the project and its parent directories, up to the
   repository root
4. `.yukioshi/` directories in the project
5. Inline JSON in `YUKIOSHI_CONFIG_CONTENT`

`.yukioshi/` directories can also hold `agent/`, `command/`, `skill/`, and
`plugin/` folders. Values such as `"{env:OPENAI_API_KEY}"` and
`"{file:./prompt.md}"` are substituted when the config is read. Run
`yukioshi debug config` to see the resolved result.

```jsonc
{
  "model": "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5",
  "instructions": ["docs/style-guide.md"],
  "permission": { "bash": "ask" },
  "mcp": {
    "docs": { "type": "remote", "url": "https://example.com/mcp" }
  },
  "memory": { "enabled": true },
  "autoupdate": true
}
```

Coming from opencode? Existing `opencode.json` files and `.opencode/`
directories are still read. See
[docs/migration-from-opencode.md](docs/migration-from-opencode.md).

## Hooks

Hooks run shell commands at fixed points in the agent's work. They use the
same conventions as Claude Code hooks: event data arrives as JSON on stdin,
exit code `2` (or printing `{"decision":"block"}`) blocks the action, and the
stdout of context hooks is added to the conversation.

| Event              | Runs                                                  | Can block |
| ------------------ | ----------------------------------------------------- | --------- |
| `preToolUse`       | before a tool call, before the permission check       | yes       |
| `postToolUse`      | after a tool call (a block is sent to the model as feedback) | feedback |
| `userPromptSubmit` | before your message is sent; stdout becomes context   | yes       |
| `sessionStart`     | when a session starts; stdout becomes context         | no        |
| `stop`             | when a task completes                                 | no        |
| `notification`     | when the agent is waiting for your approval           | no        |

```json
{
  "hooks": {
    "preToolUse": [{ "matcher": "bash", "command": "./scripts/check-command.sh" }],
    "postToolUse": [{ "matcher": "edit|write", "command": "npx prettier --write .", "timeoutMs": 30000 }],
    "notification": [{ "command": "notify-send 'YukiOshi Code' 'Waiting for approval'" }]
  }
}
```

`matcher` is a regular expression matched against the whole tool id (`bash`,
`edit`, `write`, `read`, `webfetch`, …); omit it to match every tool. Tool
hooks receive `tool_name`, `tool_input`, and `session_id`, and every hook gets
`YUKIOSHI_PROJECT_DIR` and `YUKIOSHI_HOOK_EVENT` in its environment. Hooks
defined by a repository run only after `yukioshi trust`.

## Skills

Skills are folders of instructions the agent loads only when a task needs
them, in the same `SKILL.md` format Claude Code uses. Each one is also a slash
command, for example `/nightmare src/auth` or `/engineering:code-review`.

Built in:

- `nightmare`, `disaster`, `bugfix`: an adversarial audit, a failure-mode
  review, and a disciplined fix workflow
- `engineering:*`: architecture, code review, debugging, deploy checklist,
  documentation, incident response, standup, system design, tech debt,
  testing strategy
- `design:*`: accessibility review, critique, handoff, design systems,
  research synthesis, user research, UX copy
- `productivity:*`: memory management, start, task management, update
- `skill-creator` and `web-artifacts-builder`

Add your own in `~/.config/yukioshi/skills/`, `.yukioshi/skills/` in a
project, or any folder listed in `skills.paths`. Skills in `~/.claude/skills`
and a project's `.claude/skills` are picked up too. Skills that come from the
current repository are namespaced `project:<name>`, so a repository can never
replace a built-in or personal skill. See
[packages/opencode/skills/README.md](packages/opencode/skills/README.md).

## Commands

| Command                                | Purpose                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `yukioshi [project]`                   | Open the terminal UI (the default command)           |
| `yukioshi run [message..]`             | Run one prompt non-interactively                     |
| `yukioshi providers login\|logout\|list` | Manage provider credentials (alias `auth`)         |
| `yukioshi models [provider]`           | List available models                                |
| `yukioshi agent create\|list`          | Create or list custom agents                         |
| `yukioshi mcp add\|list\|auth\|logout\|debug` | Manage MCP servers                            |
| `yukioshi session list\|delete`        | Manage sessions                                      |
| `yukioshi export [sessionID]` / `import <file>` | Export or import a session as JSON          |
| `yukioshi stats`                       | Token usage and cost statistics                      |
| `yukioshi trust [dir]`                 | Trust a repository's hooks and plugins               |
| `yukioshi plugin <module>`             | Install a plugin and update config                   |
| `yukioshi serve` / `attach <url>`      | Run a headless server / attach a TUI to one          |
| `yukioshi github install\|run`         | Set up and run the GitHub Actions agent              |
| `yukioshi pr <number>`                 | Check out a GitHub PR branch and start a session     |
| `yukioshi acp`                         | Start an Agent Client Protocol server                |
| `yukioshi completion`                  | Print a shell completion script                      |
| `yukioshi upgrade [target]`            | Upgrade to the latest or a specific version          |
| `yukioshi uninstall`                   | Remove YukiOshi Code and its files                   |
| `yukioshi debug …`                     | Inspect config, skills, paths, LSP, and more         |

Run `yukioshi <command> --help` for the options of each.

## Development

Requires [Bun](https://bun.sh) 1.3 or newer.

```bash
git clone https://github.com/ahmed-alxawad/YukiOshiCode.git
cd YukiOshiCode
bun install
bun run dev              # run the CLI from source
bun run typecheck        # typecheck every package
```

Run tests from the package that owns them, for example:

```bash
cd packages/opencode
bun test test/tool/edit.test.ts
```

Build a binary for your own platform:

```bash
cd packages/opencode
bun run script/build.ts --single --skip-embed-web-ui
./dist/yukioshi-*/bin/yukioshi --version
```

| Package                | Contents                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `packages/opencode`    | The `yukioshi` CLI: agent loop, tools, sessions, server, built-in skills |
| `packages/tui`         | Terminal UI                                                        |
| `packages/core`        | Shared config schema, permissions, providers, verification        |
| `packages/llm`         | Model-provider protocol layer                                     |
| `packages/sandbox`     | OS-level sandbox (bubblewrap, `sandbox-exec`)                     |
| `packages/indexing`    | Embedding index behind `code_search`                              |
| `packages/sdk`, `packages/plugin` | Client SDK and plugin API                              |

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
when a `v*` tag is pushed.

## License and attribution

YukiOshi Code is source-available, not open source. The repository is
public so you can read it and install the official releases, but YukiOshi
Code's own code, skills, and brand assets are © 2026 Ahmed Alxawad, all rights
reserved. See [LICENSE](LICENSE) for what you may do.

YukiOshi Code is based on [opencode](https://github.com/anomalyco/opencode),
and its sandbox and code-indexing packages are ported from
[Kilo Code](https://github.com/Kilo-Org/kilocode). Those portions remain under
their MIT license ([licenses/opencode-kilocode-MIT.txt](licenses/opencode-kilocode-MIT.txt)),
and the bundled third-party skills remain under Apache-2.0. See
[NOTICE.md](NOTICE.md) for details.
