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

  // Optional dollar and token limits; omitted means unlimited
  "budget": { "daily": 10, "monthly": 100, "tokens": { "session": 500000 } },

  // Optional outgoing notifications; omitted means disabled
  "webhooks": [{
    "url": "https://example.test/yukioshi",
    "events": ["turn.finished", "turn.failed"],
    "secret": "{env:YUKIOSHI_WEBHOOK_SECRET}"
  }],

  // Optional authenticated trigger on yukioshi serve (global only, off by default)
  "triggers": {
    "enabled": true,
    "token_env": "YUKIOSHI_TRIGGER_TOKEN",
    "directories": ["/home/user/projects/my-repo"],
    "mode": "review" // "review" (default) or "plan"
  },

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
| `redact`               | mask secrets before sending to model: `enabled` (default true), `patterns`, `allow` | [Permissions and safety](permissions-and-safety.md#secret-redaction) |
| `hooks`                | your commands at fixed points in the agent's work                   | [Hooks](hooks.md)                           |
| `skills`               | extra skill folders (`paths`), skill indexes (`urls`), and skills YukiOshi writes itself (`learn`, off by default) | [Skills](skills.md)                         |
| `memory`, `indexing`, `code_graph` | optional features (`memory.max_chars` caps memory, default 4000) | [Features](features.md)                     |
| `mcp`                  | MCP servers (`local` command or `remote` URL)                       |                                             |
| `agent`                | custom agents and per-agent models, prompts, and permissions        |                                             |
| `instructions`         | extra instruction files                                             |                                             |
| `lsp`, `formatter`     | language servers (off unless `lsp` is `true` or an object) and formatters |                                             |
| `lsp_tool`             | the `lsp` code navigation tool when language servers are on (off by default) | [Features](features.md#code-navigation) |
| `web_search`           | the `websearch` tool: `enabled` (off by default), `provider` (`exa` or `parallel`) | [Features](features.md#web-search) |
| `compaction`           | how long conversations are summarised to stay within context        |                                             |
| `goal`                 | `/goal`: `enabled` and `max_rounds` (default 20)                    | [Features](features.md)                     |
| `loop`                 | `/loop` (off by default): `enabled`, `max_runs` (50), `min_interval` seconds (60) | [Features](features.md#loop) |
| `fallback`             | backup `models` and API-key rotation when a provider fails (off by default) | [Providers](providers.md#fallback-models-and-key-rotation) |
| `tool_limits`          | repeated-call note (`repeat_nudge`) and per-tool time limits (`timeout`) | [Tool limits](#tool-limits)                 |
| `tool_search`          | load MCP tool schemas on demand (`auto`, `true`, `false`) and size threshold | [MCP tool search](#mcp-tool-search) |
| `webhooks`             | optional outgoing notifications for turns, permission asks, and questions | [Webhooks](#webhooks) |
| `budget`               | optional dollar/token limits for a session, day, or month | [Spending limits](#spending-limits) |
| `delegate`             | hand tasks to other coding agents over ACP: `enabled`, `agents` (off by default) | [Features](features.md#delegating-to-other-agents) |
| `browser`              | browser automation via Playwright MCP: `enabled` (off by default), `headless` (default true), `engine` (`chrome`, `chromium`, `firefox`, `webkit`, `msedge`) | [Features](features.md#browser-automation) |
| `checkpoints`          | durable git commits on `refs/yukioshi/checkpoints/*` (off by default) | [Features](features.md#git-checkpoints) |
| `audit`                | local log of tool calls and approvals: `enabled` (off by default; global config only) | [Permissions and safety](permissions-and-safety.md#audit-log) |
| `subagents`            | background subagents (`background`) and the `task_parallel` tool (`parallel`), both off by default | [Features](features.md#subagents) |
| `share`, `enterprise.url` | session sharing (`manual`, `auto`, `disabled`) and the share server it needs | [Features](features.md) |
| `triggers`             | authenticated HTTP trigger endpoint on `yukioshi serve` (global only) | [Features](features.md#triggers) |
| `autoupdate`           | update behaviour                                                    | [Installation](installation.md)             |

In a repository you have not trusted, `hooks`, `plugin`, `delegate`, `webhooks`,
`browser`, local MCP servers, `lsp` and `formatter` entries with their own command, and
custom provider endpoints (`api`, `options.baseURL`, `options.headers`, credentials)
as well as project-only providers (e.g. Ollama, vLLM, LM Studio) are ignored
until you run `yukioshi trust .`. See
[Permissions and safety](permissions-and-safety.md#repository-trust).

## Spending limits

Spending limits are off unless `budget` is configured. Set `session`, `daily`,
or `monthly` in US dollars, or use the matching `tokens` limits for providers
without reliable prices. Limits include subagent usage and all projects stored
in the same YukiOshi data store. At 80% YukiOshi warns once per session; at the
limit it stops before the next model request and explains how to raise the
limit. `yukioshi run` exits with status 6 when a limit stops the turn (see
[exit codes](commands.md#exit-codes)).

```jsonc
{
  "budget": {
    "session": 2,
    "daily": 10,
    "monthly": 100,
    "tokens": { "session": 200000 }
  }
}
```

## Webhooks

Webhooks are off unless `webhooks` is configured. Each matching event sends a
small JSON notification for `turn.finished`, `turn.failed`, `permission.asked`,
or `question.asked`. Notifications never include prompts, message text, file
contents, tool output, or environment values. A webhook can set `headers` and
an `events` subset; omitted `events` means all four events.

When `secret` is set, YukiOshi sends `X-YukiOshi-Signature: sha256=<hex>`.
Verify the raw request body before parsing it:

```ts
const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex")
const a = Buffer.from(signature ?? "")
const b = Buffer.from(expected)
// timingSafeEqual throws on different lengths, so compare lengths first.
if (a.length === b.length && timingSafeEqual(a, b)) accept()
```

Delivery has a 10-second timeout and retries network errors and 5xx responses
twice. 4xx responses are not retried, and delivery never delays the agent.

## Tool limits

When the model calls the same tool with the same input three times in one turn
and gets the same result each time, YukiOshi adds a note to that result telling
it to use what it already has or change approach. From the fifth time the note
is firmer. A call whose result changed (tests re-run after an edit) never
counts. Turn the note off with `"repeat_nudge": false`.

Tools have no time limit of their own by default. `timeout` (milliseconds)
stops a tool call that runs too long; the model is told it was stopped and the
turn continues:

```json
{
  "tool_limits": {
    "timeout": { "*": 120000, "webfetch": 30000, "my-mcp-server_query": 60000 }
  }
}
```

MCP tools are named `<server>_<tool>`. A single number applies to every tool. `"*"` covers every tool not named, except
`bash` (it has its own `timeout`), `task`, `task_parallel`, `question`, and
`plan_exit`, which wait on a command, a subagent, or you; name one of them to
limit it anyway. `0` turns a limit off.

## MCP tool search

When you configure MCP servers with many tools, sending all tool schemas on every request can consume tens of kilobytes of context. Tool search defers loading MCP tool definitions until the model searches or selects them.

By default (`"enabled": "auto"`), tool search turns on when total MCP tool definitions exceed 20,000 characters. You can force it on (`true`), turn it off (`false`), or adjust the threshold:

```json
{
  "tool_search": {
    "enabled": "auto",
    "threshold": 20000
  }
}
```

When search mode is active, the model receives a `tool_search` tool listing available deferred tool names and brief summaries. When the model searches or selects a tool (`select:tool_name`), the tool's full definition is loaded for all subsequent steps in the session.

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
| `YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS` | enable the `task_parallel` tool (same as `subagents.parallel`) |
| `YUKIOSHI_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | enable background subagents (same as `subagents.background`) |
| `YUKIOSHI_SERVER_PASSWORD`, `YUKIOSHI_SERVER_USERNAME` | protect `yukioshi serve` with a password |
