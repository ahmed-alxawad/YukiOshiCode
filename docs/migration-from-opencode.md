# Migrating from opencode

YukiOshi Code is a fork of [opencode](https://github.com/anomalyco/opencode).
It keeps opencode's architecture, configuration format, and multi-provider
model system, and adds features aimed at a more controlled coding-agent
workflow. Most opencode setups work after a few renames.

## What is different

**Renamed**

| opencode                         | YukiOshi Code                          |
| -------------------------------- | -------------------------------------- |
| `opencode` command               | `yukioshi`                             |
| `@opencode-ai/*` packages        | `@yukioshi/*`                          |
| `OPENCODE_*` environment variables | `YUKIOSHI_*`                         |
| `opencode.json`, `.opencode/`    | `yukioshi.json`, `.yukioshi/` (old names still read; `.jsonc` supported) |
| `.opencodeignore`                | `.yukioshiignore` (old name still read) |
| `~/.config/opencode/`            | `~/.config/yukioshi/`                  |
| data, cache, and state in `opencode` directories | the same locations under `yukioshi` |

**Added**

- Permission modes (`manual`, `auto`, `auto-all`, `plan`) and hard safety
  blocks that no rule or mode can override.
- An optional OS-level sandbox for shell commands, also enforced by the
  `write` and `edit` tools (`sandbox`).
- Repository trust: a repository's hooks and plugins run only after
  `yukioshi trust`.
- Project trust records a fingerprint of the repository's executable config (hooks, plugins, MCP/LSP/formatter commands) and lapses when that config changes.
- Untrusted repositories can't start local MCP servers or custom LSP/formatter commands.
- Installers verify release checksums, and Windows has `install.ps1`.
- API keys and OAuth tokens stored in the OS keychain.
- Claude Code-compatible hooks for six events (`hooks`).
- Project memory (`memory`), semantic code search (`indexing`), and a code
  graph tool (`code_graph`), all off by default.
- Background subagents, and parallel subagents in isolated git worktrees (`subagents` in config, off by default).
- Optional post-turn verification (`--verify`) that runs the project's
  typecheck, lint, and test commands and reports the evidence.
- Bundled skills (`nightmare`, `disaster`, `bugfix`, and the `engineering:*`,
  `design:*`, and `productivity:*` families). Project skills are namespaced
  `project:<name>`.
- Built-in sign-in for ChatGPT (Codex), SuperGrok, and Google AI Studio, plus
  a Google AI Studio preset. See
  [Providers](providers.md).
- Its own YukiOshi theme for light and dark terminals. See
  [Appearance](appearance.md).

**Not included**: opencode's web and desktop apps (YukiOshi Code is a
terminal application), and OpenCode's providers (OpenCode, OpenCode Zen, and
OpenCode Go), which OpenCode limits to its own client; see
[Providers](providers.md#opencode). YukiOshi also never picks a model for you:
choose one with `/models` or set `model` in `yukioshi.json`.

## Migration checklist

1. Install YukiOshi Code and replace `opencode` with `yukioshi` in shell
   aliases, editor tasks, CI jobs, and scripts.
2. Replace application environment variables named `OPENCODE_*` with
   `YUKIOSHI_*`. Provider credentials keep their own names, such as
   `ANTHROPIC_API_KEY`.
3. Copy your global configuration from `~/.config/opencode/` to
   `~/.config/yukioshi/` (rename `opencode.json` to `yukioshi.json` if you
   like). YukiOshi does not read opencode's global directories.
4. Project files need no immediate change: `opencode.json`,
   `opencode.jsonc`, `.opencode/`, and `.opencodeignore` are still read. When
   both names exist in the same place, the YukiOshi file wins. Rename them
   when convenient.
5. Sign in to your providers again with `yukioshi providers login`.
   Credentials are not copied from opencode.
6. If a repository uses hooks, plugins, local MCP servers, or custom
   LSP/formatter commands, run `yukioshi trust .` in it once you have reviewed
   them. Re-run it if that executable configuration changes.
7. In code that imports the SDK or plugin API, replace `@opencode-ai/*` with
   `@yukioshi/*`. Leave third-party names such as `opencode-gitlab-auth`
   unchanged.
8. Turn on the optional features you want in `yukioshi.json`: `sandbox`,
   `memory`, `indexing`, `code_graph`, and `hooks`.

## Names that intentionally stay "opencode"

Not every remaining `opencode` is a missed rename. Third-party plugin packages,
plugin compatibility fields, and the built-in `customize-opencode` skill keep
their names so existing integrations keep working.
