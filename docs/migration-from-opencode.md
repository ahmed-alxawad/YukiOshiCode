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
| `opencode.json`, `.opencode/`    | `yukioshi.json`, `.yukioshi/` (old names still read) |
| `~/.config/opencode/`            | `~/.config/yukioshi/`                  |
| data, cache, and state in `opencode` directories | the same locations under `yukioshi` |

**Added**

- Permission modes (`manual`, `auto`, `auto-all`, `plan`) and hard safety
  blocks that no rule or mode can override.
- An optional OS-level sandbox for shell commands, also enforced by the
  `write` and `edit` tools (`sandbox`).
- Repository trust: a repository's hooks and plugins run only after
  `yukioshi trust`.
- API keys and OAuth tokens stored in the OS keychain.
- Claude Code-compatible hooks for six events (`hooks`).
- Project memory (`memory`), semantic code search (`indexing`), and a code
  graph tool (`code_graph`), all off by default.
- Parallel subagents in isolated git worktrees (`task_parallel`, experimental).
- Post-turn verification that runs the project's typecheck, lint, and test
  commands and reports the evidence.
- Bundled skills (`nightmare`, `disaster`, `bugfix`, and the `engineering:*`,
  `design:*`, and `productivity:*` families). Project skills are namespaced
  `project:<name>`.
- Google AI Studio and OpenCode Zen provider presets and built-in ChatGPT /
  Codex sign-in. See [providers.md](providers.md).

**Not included**: opencode's web and desktop apps. YukiOshi Code is a
terminal application.

## Migration checklist

1. Install YukiOshi Code and replace `opencode` with `yukioshi` in shell
   aliases, editor tasks, CI jobs, and scripts.
2. Replace application environment variables named `OPENCODE_*` with
   `YUKIOSHI_*`. Provider credentials keep their own names: OpenCode Zen, for
   example, still reads `OPENCODE_API_KEY`.
3. Copy your global configuration from `~/.config/opencode/` to
   `~/.config/yukioshi/` (rename `opencode.json` to `yukioshi.json` if you
   like). YukiOshi does not read opencode's global directories.
4. Project files need no immediate change: `opencode.json` and `.opencode/`
   are still read. When both names exist in the same place, the YukiOshi file
   wins. Rename them when convenient.
5. Sign in to your providers again with `yukioshi providers login`.
   Credentials are not copied from opencode.
6. If a repository uses hooks or plugins, run `yukioshi trust .` in it once
   you have reviewed them.
7. In code that imports the SDK or plugin API, replace `@opencode-ai/*` with
   `@yukioshi/*`. Leave third-party names such as `opencode-gitlab-auth`
   unchanged.
8. Turn on the optional features you want in `yukioshi.json`: `sandbox`,
   `memory`, `indexing`, `code_graph`, and `hooks`.

## Names that intentionally stay "opencode"

Not every remaining `opencode` is a missed rename. The `opencode` and
`opencode-zen` provider IDs, opencode service URLs, third-party plugin
packages, plugin compatibility fields, and the built-in `customize-opencode`
skill keep their names so existing integrations keep working.
