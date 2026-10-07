# Commands

Run `yukioshi <command> --help` for every option of a command. All commands
accept `--print-logs`, `--log-level DEBUG|INFO|WARN|ERROR`, and `--pure`
(run without external plugins).

## Everyday

| Command                         | Does                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `yukioshi [folder]`             | open the terminal UI in a folder (default: the current one) |
| `yukioshi run [message..]`      | send one message without the terminal UI                |
| `yukioshi providers login`      | connect a provider (alias: `yukioshi auth login`)       |
| `yukioshi providers list`       | show connected providers and credentials                |
| `yukioshi providers logout`     | remove a credential                                     |
| `yukioshi models [provider]`    | list the models you can use                             |
| `yukioshi trust [folder]`       | trust a repository's hooks, plugins, and commands (`--status`, `--revoke`) |
| `yukioshi checkpoint <action>`  | list, show, restore, or prune durable Git checkpoints |
| `yukioshi worktree <action>`    | create (`new`), `list`, locate (`path`), or `remove` Git worktrees for parallel sessions |
| `yukioshi upgrade [version]`    | upgrade to the latest or a specific version             |
| `yukioshi uninstall`            | remove YukiOshi Code                                    |

Options for the terminal UI include `-m provider/model`, `--agent`, `-c`
(continue the last session), `-s <id>` (open a session), `--prompt`, `--auto`
(approve everything that is not explicitly denied), `--mini` (a minimal
interface), and `--verify` (turn on post-turn verification).

### `yukioshi run`

| Option                     | Effect                                                      |
| -------------------------- | ----------------------------------------------------------- |
| `-m, --model`              | model as `provider/model`                                   |
| `--agent`                  | mode or agent: `build`, `plan`, `goal`, `reasoning`, `research`, `auto`, or a custom agent; an unknown name stops with an error |
| `--mode`                   | permission mode: `manual`, `auto`, `auto-all`, `plan`, or `review` (what it may do without asking; not the same as `--agent auto`; see [review mode](permissions-and-safety.md#review-mode)) |
| `-c, --continue`           | continue the last session                                   |
| `-s, --session`            | continue a session by id                                    |
| `--fork`                   | fork the session before continuing                          |
| `-f, --file`               | attach files                                                |
| `--format json`            | print raw JSON events, one per line                         |
| `--thinking`               | show the model's reasoning                                  |
| `--variant`                | provider-specific reasoning effort, such as `high` or `minimal` |
| `--command`                | run a slash command; the message becomes its arguments      |
| `--title`                  | name the session (by default a one-shot run is named after its message) |
| `--share`                  | share the session; needs your own share server (see [Features](features.md)) |
| `--attach <url>`           | send the message to a running `yukioshi serve`              |
| `--dir`                    | folder to run in                                            |
| `--worktree <name>`        | run in a Git worktree of this project (created if needed; see [Features](features.md#worktrees)) |
| `--verify`, `--skip-verify` | turn post-turn verification on or off                      |
| `--output-schema <schema>` | the final answer must match this JSON Schema (a file, or inline JSON); stdout then holds only that answer, as JSON |
| `--max-turns <n>`          | stop after this many model turns                            |
| `--max-cost <dollars>`     | stop once this run has cost this much (subagents included; models without prices count as free) |

#### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0    | finished; a goal worked on in this run is done |
| 1    | an error: it could not start (no model chosen, an unknown model or `--agent`), the provider failed, or the answer did not match `--output-schema` |
| 3    | a goal needs you: its check asked for a decision or access, or a permission was refused |
| 4    | a goal used all its rounds (`goal.max_rounds`); `/goal resume` continues it |
| 5    | stopped at `--max-turns` |
| 6    | stopped by a spending limit: `--max-cost` or the `budget` setting |

For 3 to 6, the reason is printed on stderr. With `--format json`, a run ends
with a `result` event that carries the same information:

```json
{"type":"result","sessionID":"ses_…","exit_code":5,"reason":"max_turns","turns":3,"cost":0.42,"message":"Stopped after 3 turns (--max-turns 3)."}
```

`reason` is one of `done`, `error`, `invalid_output`, `goal_blocked`,
`goal_rounds`, `max_turns`, `max_cost`, or `budget`. With `--output-schema`,
the event also has the answer as `structured`.

#### Structured answers

```bash
yukioshi run --output-schema '{"type":"object","properties":{"risk":{"enum":["low","high"]},"files":{"type":"array","items":{"type":"string"}}},"required":["risk","files"]}' \
  "review the staged changes" | jq .risk
```

The model must answer through the schema; anything else it writes goes to
stderr. `--output-schema` cannot be combined with `--command`.

#### Piping input

Text piped into `run` becomes the message, or is added to it:

```bash
git diff | yukioshi run "review this change"
cat error.log | yukioshi run
```

When you give a message and nothing arrives on stdin within 3 seconds,
`run` continues without stdin and says so. This keeps scripts and other
programs that start YukiOshi with an open, unused pipe from waiting forever.
Run with `< /dev/null` to skip the wait.

### `yukioshi schedule`

Manage recurring prompts run by your operating system's background scheduler (crontab on Linux/macOS or Task Scheduler on Windows).

| Subcommand | Effect |
| ---------- | ------ |
| `yukioshi schedule add "<cron>" "<prompt>"` | schedule a prompt (options: `--name`, `--dir`, `--model`, `--agent`, and `--auto` to approve every action or `--review` to have a model decide them) |
| `yukioshi schedule list` | list configured scheduled jobs, schedules, next run times, and statuses |
| `yukioshi schedule run <id>` | execute the scheduled job immediately |
| `yukioshi schedule logs <id> [--last]` | view output logs of previous runs |
| `yukioshi schedule enable <id>` | enable a scheduled job |
| `yukioshi schedule disable <id>` | disable a scheduled job |
| `yukioshi schedule remove <id>` | remove a scheduled job and clean up its entry from the system scheduler |

## Sessions and data

| Command                         | Does                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `yukioshi session list`         | list sessions                                           |
| `yukioshi session delete <id>`  | delete a session                                        |
| `yukioshi export [id]`          | export a session as JSON (`--sanitize` redacts sensitive data) |
| `yukioshi import <file or url>` | import a session                                        |
| `yukioshi stats`                | token use and cost (`--days`, `--models`, `--tools`, `--project`) |

In the TUI, `/changes` shows the files changed by the latest turn. With
`"loop": { "enabled": true }`, `/loop 5m <prompt>` runs a prompt again on an
interval; see [Features](features.md#loop).

## Agents, plugins, and MCP

| Command                                  | Does                                     |
| ---------------------------------------- | ---------------------------------------- |
| `yukioshi agent create`, `agent list`    | create or list custom agents             |
| `yukioshi plugin <module>`               | install a plugin and add it to your config |
| `yukioshi mcp add`, `list`, `auth`, `logout`, `debug` | manage MCP servers and their sign-in |

## Servers and integrations

| Command                         | Does                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `yukioshi serve`                | run without the terminal UI (`--port`, `--hostname`; protect it with `YUKIOSHI_SERVER_PASSWORD`) |
| `yukioshi attach <url>`         | open the terminal UI against a running server          |
| `yukioshi acp`                  | start an Agent Client Protocol server for editors       |
| `yukioshi pr <number>`          | check out a pull request and open a session on it       |

## Troubleshooting

| Command                         | Does                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `yukioshi debug config`         | print the merged configuration                          |
| `yukioshi debug paths`          | print YukiOshi's data, config, and cache folders        |
| `yukioshi debug skill`          | list the skills it found                                |
| `yukioshi debug lsp …`, `debug rg …`, `debug file …` | language server, search, and file checks |
| `yukioshi debug agent <name>`   | show an agent's resolved configuration                  |
| `yukioshi debug info`           | version and environment details for bug reports         |
| `yukioshi db`                   | database tools                                          |
| `yukioshi completion`           | print a shell completion script                         |
