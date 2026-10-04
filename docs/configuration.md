# Configuration

YukiOshi reads JSON or JSONC (JSON with comments) from a few places and merges
them. Run `yukioshi debug config` to see the result for the current folder.

## Files and precedence

Later sources override earlier ones:

1. **Global**: `~/.config/yukioshi/yukioshi.json` (or `.jsonc`)
2. **`YUKIOSHI_CONFIG`**: a config file named by this variable
3. **Project**: `yukioshi.json` in the current folder and each parent folder up
   to the repository root
4. **Project folders**: `.yukioshi/` in the project, plus `YUKIOSHI_CONFIG_DIR`
   if set
5. **`YUKIOSHI_CONFIG_CONTENT`**: inline JSON in this variable
6. **Managed**: system-wide settings an administrator puts in
   `/etc/yukioshi` (Linux), `/Library/Application Support/yukioshi` (macOS), or
   `%ProgramData%\yukioshi` (Windows), and macOS managed preferences deployed
   through MDM. These override everything else.

Older `opencode.json` files and `.opencode/` folders are still read; when both
names exist in the same place, the YukiOshi file wins. Set
`YUKIOSHI_DISABLE_PROJECT_CONFIG=1` to ignore project files entirely.

A `.yukioshi/` folder can also hold:

| Folder                 | Contains                                     |
| ---------------------- | -------------------------------------------- |
| `agent/` or `agents/`  | custom agents, one Markdown file each        |
| `command/` or `commands/` | custom slash commands                     |
| `skill/` or `skills/`  | skills (see [Skills](skills.md))             |
| `plugin/` or `plugins/` | plugins (run only in trusted repositories)  |

Settings for the terminal UI itself (theme, keybindings) live in a separate
`tui.json` next to `yukioshi.json`. See [Appearance](appearance.md).

## Variables

String values can pull in environment variables and files when the config is
read:

```jsonc
{
  "provider": { "openai": { "options": { "apiKey": "{env:OPENAI_API_KEY}" } } },
  "instructions": ["{file:./docs/agent-rules.md}"]
}
```

Keep API keys out of checked-in config files: use `{env:…}` or
`yukioshi providers login`, which stores them in your OS keychain.

## Common settings

```jsonc
{
  // The model for the main agent, and a cheaper one for small jobs like titles
  "model": "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5",

  // Extra instruction files added to every session
  "instructions": ["CONTRIBUTING.md"],

  // What the agent may do without asking (see Permissions and safety)
  "permission": { "edit": "ask", "bash": { "*": "ask", "npm test": "allow" } },

  // MCP servers
  "mcp": {
    "docs": { "type": "remote", "url": "https://example.com/mcp" },
    "files": { "type": "local", "command": ["npx", "-y", "@example/mcp-files"] }
  },

  // Optional features, all off by default (see Features)
  "memory": { "enabled": true },
  "sandbox": { "enabled": true },

  "autoupdate": "notify"
}
```

| Key                    | Purpose                                                             | Guide                                       |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| `model`, `small_model` | default models, as `provider/model`                                 | [Providers](providers.md)                   |
| `provider`             | provider options, custom endpoints, extra models                    | [Providers](providers.md)                   |
| `enabled_providers`, `disabled_providers` | limit which providers load                       | [Providers](providers.md)                   |
| `permission`           | per-tool rules: `allow`, `ask`, or `deny`                           | [Permissions and safety](permissions-and-safety.md) |
| `sandbox`              | OS sandbox for shell commands and file edits                        | [Permissions and safety](permissions-and-safety.md) |
| `hooks`                | your commands at fixed points in the agent's work                   | [Hooks](hooks.md)                           |
| `skills`               | extra skill folders (`paths`) and skill indexes (`urls`)            | [Skills](skills.md)                         |
| `memory`, `indexing`, `code_graph` | optional features                                       | [Features](features.md)                     |
| `mcp`                  | MCP servers (`local` command or `remote` URL)                       |                                             |
| `agent`                | custom agents and per-agent models, prompts, and permissions        |                                             |
| `instructions`         | extra instruction files                                             |                                             |
| `lsp`, `formatter`     | language servers and formatters                                     |                                             |
| `compaction`           | how long conversations are summarised to stay within context        |                                             |
| `goal`                 | `/goal`: `enabled` and `max_rounds` (default 20)                    | [Features](features.md)                     |
| `share`, `enterprise.url` | session sharing (`manual`, `auto`, `disabled`) and the share server it needs | [Features](features.md) |
| `autoupdate`           | update behaviour                                                    | [Installation](installation.md)             |

In a repository you have not trusted, `hooks`, `plugin`, local MCP servers, and
`lsp` and `formatter` entries with their own command are ignored until you run
`yukioshi trust .`. See
[Permissions and safety](permissions-and-safety.md#repository-trust).

## Environment variables

| Variable                              | Effect                                                    |
| ------------------------------------- | --------------------------------------------------------- |
| `YUKIOSHI_CONFIG`                     | load an extra config file                                 |
| `YUKIOSHI_CONFIG_DIR`                 | load an extra config folder                               |
| `YUKIOSHI_CONFIG_CONTENT`             | load inline JSON config                                   |
| `YUKIOSHI_DISABLE_PROJECT_CONFIG`     | ignore project config files                               |
| `YUKIOSHI_DISABLE_AUTOUPDATE`         | never check for updates                                   |
| `YUKIOSHI_DISABLE_KEYCHAIN`           | store credentials in a file instead of the OS keychain    |
| `YUKIOSHI_DISABLE_CLAUDE_CODE_SKILLS` | do not read skills from `.claude/` folders                |
| `YUKIOSHI_SKIP_VERIFY`                | turn post-turn verification off                           |
| `YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS` | enable the `task_parallel` tool                          |
| `YUKIOSHI_SERVER_PASSWORD`, `YUKIOSHI_SERVER_USERNAME` | protect `yukioshi serve` with a password |
