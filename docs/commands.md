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
| `--mode`                   | permission mode: `manual`, `auto`, `auto-all`, or `plan` (what it may do without asking; not the same as `--agent auto`) |
| `-c, --continue`           | continue the last session                                   |
| `-s, --session`            | continue a session by id                                    |
| `--fork`                   | fork the session before continuing                          |
| `-f, --file`               | attach files                                                |
| `--format json`            | print raw JSON events, one per line                         |
| `--thinking`               | show the model's reasoning                                  |
| `--variant`                | provider-specific reasoning effort, such as `high` or `minimal` |
| `--command`                | run a slash command; the message becomes its arguments      |
| `--title`                  | name the session                                            |
| `--attach <url>`           | send the message to a running `yukioshi serve`              |
| `--dir`                    | folder to run in                                            |
| `--verify`, `--skip-verify` | turn post-turn verification on or off                      |

## Sessions and data

| Command                         | Does                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `yukioshi session list`         | list sessions                                           |
| `yukioshi session delete <id>`  | delete a session                                        |
| `yukioshi export [id]`          | export a session as JSON (`--sanitize` redacts sensitive data) |
| `yukioshi import <file or url>` | import a session                                        |
| `yukioshi stats`                | token use and cost (`--days`, `--models`, `--tools`, `--project`) |

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
