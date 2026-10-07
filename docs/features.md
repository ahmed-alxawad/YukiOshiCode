# Features

## Modes

Press `tab` in the terminal UI to switch modes (or pick one with `/modes`), or
start in one with `--agent <mode>` (for example
`yukioshi run --agent research "…"`).

| Mode          | For                                                                 | File tools |
| ------------- | ------------------------------------------------------------------- | ---------- |
| **Build**     | everyday work: write and change code, fix bugs, run commands        | on         |
| **Plan**      | designing an approach before any change; writes a plan file          | plan file only |
| **Goal**      | a larger objective: works step by step on its own, verifying as it goes, until it is done | on |
| **Reasoning** | hard questions: thinks it through and answers, using the model's high reasoning effort when available | off |
| **Research**  | gathering information from the codebase and the web, reported with sources | off |
| **Auto**      | picks one of the five above for each message                        | as the mode it picks |

In Plan, Reasoning, and Research the edit and write tools are off, but shell
commands still follow your permission rules, so the agent can inspect the
project (`git log`, `ls`, running tests). Reasoning and Research also refuse
shell commands that throw work away (`git clean`, `git checkout -- …`,
`git reset --hard`, `git restore`, `git stash`, `rm`).

Auto makes one quick call to the session's small model for each message to
choose the mode (falling back to the message's wording if that fails), and the
reply shows the mode it ran in. Name a mode in the message ("use research mode:
…") to skip that call. A message's mode stays fixed until it finishes,
including after the conversation is compacted; the next message is routed
again.

If your configuration already defines an agent named `goal`, `reasoning`,
`research`, or `auto` with its own prompt, YukiOshi keeps your agent under
that name instead of the built-in mode.

These modes decide *how* the agent works. Permission modes (`manual`, `auto`,
`auto-all`, `plan`, see [Permissions and safety](permissions-and-safety.md))
separately decide *what it may do without asking*; any mode can be combined
with any permission mode.

## Goals

`/goal <what you want done>` gives the session a standing objective. YukiOshi
works on it, and after every turn a small model checks whether the goal is
met. If it is not, YukiOshi continues on its own with a note of what is still
missing, until the goal is done.

```
/goal make every test in packages/api pass and fix the lint errors
```

| Command          | Does                                              |
| ---------------- | ------------------------------------------------- |
| `/goal <text>`   | set the goal and start working on it             |
| `/goal`          | show the goal, its status, and rounds used        |
| `/goal pause`    | stop continuing after the current turn            |
| `/goal resume`   | continue a paused goal (with a fresh round allowance) |
| `/goal clear`    | remove the goal                                    |

A goal pauses by itself when you interrupt, when a permission is refused, when
a turn ends with an error, when the check says it needs you (a question, a
decision, or missing access), or after `goal.max_rounds` continuation rounds
(default 20). Each check is one small-model call. It also works from scripts:
`yukioshi run --command goal "…"`. Turn it off with
`"goal": { "enabled": false }`.

## Loop

Off by default. Turn it on with `"loop": { "enabled": true }`, and `/loop`
runs a prompt or a slash command again on an interval in the current session,
for example to watch a CI run or a deploy:

```
/loop 5m check whether the CI run for this branch has finished and summarise failures
/loop 30m /review
```

| Command                    | Does                                              |
| -------------------------- | ------------------------------------------------- |
| `/loop <interval> <prompt>` | run it now, then again every interval (`90s`, `5m`, `1h30m`; 10 minutes if left out) |
| `/loop`                    | show the loop, its runs, and when it runs next    |
| `/loop stop`               | stop the loop                                     |

Each run waits until the session is idle, so it never interrupts your own
messages, and shows a short notice in the terminal UI so a forgotten loop does
not keep spending tokens unnoticed. A loop stops by itself when a run fails, when you interrupt a run, or
after `loop.max_runs` runs (default 50). Intervals shorter than
`loop.min_interval` (default 60 seconds) are raised to it. One loop runs per
session, and it lasts as long as the terminal UI or `yukioshi serve` keeps
running; `yukioshi run` exits after the first run.

## Scheduled tasks

`yukioshi schedule` runs prompts on a recurring cron schedule, for example to summarize commits every morning or review dependencies weekly.

Unlike `/loop` (which runs in an active terminal session or server), scheduled tasks integrate directly into your operating system's background scheduler without running a continuous background daemon of our own:
- **Linux and macOS:** manages a clearly marked block (`# BEGIN yukioshi schedule` ... `# END yukioshi schedule`) in your user `crontab`, leaving all other cron entries untouched.
- **Windows:** registers tasks in Windows Task Scheduler via `schtasks` (under `YukiOshi\<id>`).

Each execution runs like `yukioshi run` in the job's directory, creates a normal session titled `Scheduled: <name>`, writes a persistent log to `<state>/schedule/<id>/<timestamp>.log` (retaining the last 50 logs per job), and enforces concurrency locks so multiple copies of the same job never run simultaneously. Spending limits (`budget`) are strictly respected: if a budget limit is reached, the run is logged as `skipped: budget`.

```bash
# Add a scheduled task (standard 5-field cron)
yukioshi schedule add "0 9 * * 1-5" "summarize yesterday's commits" --name "daily-summary" --auto

# Inspect, run, or view logs
yukioshi schedule list
yukioshi schedule run <id>
yukioshi schedule logs <id> [--last]
yukioshi schedule disable <id>
yukioshi schedule enable <id>
yukioshi schedule remove <id>
```

## Usage

`/usage` (or `/cost`) shows the current session's model, context use, tokens,
and cost, plus token and cost totals across all projects for today, the last 7
days, and the last 30 days. Costs are estimates from each model's list price;
subscription sign-ins such as ChatGPT and SuperGrok count against the plan's
own limits instead. `yukioshi stats` gives a longer breakdown in the shell.

## Post-turn verification

After a turn that changed files, YukiOshi can run your project's own checks and
report the evidence instead of trusting the model's word.

Verification is off by default, because full test and typecheck runs can take
longer than the change itself. Turn it on per session:

```bash
yukioshi --verify            # terminal UI
yukioshi run --verify "…"    # one-off run
```

What it does:

- finds the project's `typecheck`, `lint`, and `test` commands from its
  metadata (for example `package.json` scripts);
- runs them only when source files changed; documentation and configuration
  edits get lightweight checks such as JSON syntax only;
- reports the result as verified, partially verified, failed, unavailable, or
  skipped, with the evidence for each check.

Override the detected commands with `YUKIOSHI_VERIFY_TEST_CMD`,
`YUKIOSHI_VERIFY_TYPECHECK_CMD`, and `YUKIOSHI_VERIFY_LINT_CMD`, or replace them
all with one `YUKIOSHI_VERIFY_COMMAND`. `YUKIOSHI_SKIP_VERIFY=1` or
`--skip-verify` turns verification off.

## Project memory

```json
{ "memory": { "enabled": true } }
```

Off by default. Adds two tools: `memory_save` to keep durable facts about a
project (how to run it, environment notes, corrections you gave), and
`memory_recall` to look them up. Saved memory is also shown to the agent at the
start of every request, corrections first, so it follows them without having to
look them up. Memory is plain Markdown in YukiOshi's data folder, one set per
repository, so you can read and edit it. Recalling is low-risk; saving counts as
a change, so `auto` mode asks first.

Because memory goes into every request, it is kept small: at most
`memory.max_chars` characters across all entries (default 4000), and 500 per
entry. When it is full, a save is refused and the agent sees the current entries
so it can forget stale ones or merge several into one before saving more.

## Semantic code search

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

Adds `code_search`, which finds code by meaning rather than exact text. Your
repository is split along symbol boundaries for about 25 languages and
embedded with the provider you choose: OpenAI, Ollama, any OpenAI-compatible
server, Gemini, Mistral, Vercel AI Gateway, Bedrock, OpenRouter, or Voyage.
Vectors are stored in an embedded LanceDB database (`"vectorStore": "lancedb"`,
the default) or a Qdrant server (`"vectorStore": "qdrant"`). Files listed in
`.yukioshiignore` (and `.gitignore`) are skipped. If indexing is enabled but not
configured, the tool says so instead of failing.

## Code graph

```json
{ "code_graph": { "enabled": true } }
```

Adds a read-only `code_graph` tool that answers structural questions (who calls
what, how modules connect) from a Graphify
graph at `graphify-out/graph.json`, with a simpler local fallback when no graph
exists. `graphPath`, `command`, `args`, `timeoutMs`, and `maxGraphBytes`
fine-tune it.

Code search and code-graph results are hints for finding code, not proof: the
agent still reads the files and runs checks before it treats a change as done.

## Spending limits

Set `budget.session`, `budget.daily`, or `budget.monthly` in dollars, and use
the matching `budget.tokens` limits for providers without usable prices. The
limits include subagents and stop the next model request before it is sent.
YukiOshi warns once at 80%; omit `budget` to keep the feature off.

## Git checkpoints

Set `{ "checkpoints": { "enabled": true } }` to save each changed turn as a
real commit on `refs/yukioshi/checkpoints/<session>`. The user's branch, HEAD,
index, and working tree are not changed while a checkpoint is created. Use
`yukioshi checkpoint list`, `show`, `restore`, or `prune`; `/checkpoints` opens
the same list in the TUI. Checkpoints work only inside a Git repository.

## Files changed summary

After a completed turn, YukiOshi can show the files changed, additions, and
deletions. The TUI setting is on by default; use `/changes` to show the latest
summary on demand. Headless `yukioshi run` prints the same summary to stderr;
use `--no-summary` to suppress it.

## Worktrees

Run several sessions on the same repository without them editing the same
files: each one works in its own Git worktree, a separate checkout on its own
branch.

```bash
yukioshi --worktree login-fix            # terminal UI in the worktree "login-fix"
yukioshi run --worktree docs "update the README"
yukioshi worktree list                   # name, branch, folder
cd "$(yukioshi worktree path login-fix)" # the folder, for your own tools
yukioshi worktree remove login-fix
```

`--worktree <name>` reuses the worktree with that name or creates it, on the
branch `yukioshi/<name>`, with the files checked out before the session
starts; without a name, one is chosen for you. Worktrees live in YukiOshi's
data folder, not inside your repository. `remove` deletes the worktree and its
branch, so it refuses while the worktree has uncommitted changes or commits
that are not on your current branch; merge or save that work first, or add
`--yes`.

## Subagents

The `task` tool lets the main agent hand a focused job to a subagent with its
own context. With `YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS=1`, the `task_parallel`
tool runs up to eight subagents, four at a time, each optionally in its own git
worktree so their edits do not collide. Worktrees are removed when the tasks
finish.

## Delegating to other agents

The `delegate` tool lets YukiOshi delegate a task or instruction to another coding agent you already have installed (such as Claude Code, OpenAI Codex, or Gemini CLI) using the Agent Client Protocol (ACP).

Delegation is **off by default**. It is enabled in your configuration when `delegate.enabled` is `true` and at least one agent is configured under `delegate.agents`:

```json
{
  "delegate": {
    "enabled": true,
    "agents": {
      "claude": {
        "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
      },
      "codex": {
        "command": ["npx", "-y", "@agentclientprotocol/codex-acp"]
      },
      "gemini": {
        "command": ["gemini", "--experimental-acp"]
      }
    }
  }
}
```

### Authentication and Billing
Delegated agents use their own existing authentication and logins (such as `~/.claude/` for Claude Code, `~/.codex/` for Codex, or `gemini login` for Gemini). Your own subscription or API plan with that external tool pays for any model requests it makes.

### Permission behaviour
When the delegated agent requests permission to execute a tool (e.g. running a terminal command or editing a file), the request is forwarded to YukiOshi as an interactive permission ask. YukiOshi never auto-approves actions on the external agent's behalf. If you deny the request in YukiOshi, a rejection is returned to the external agent.

The `delegate` tool itself is classified as high-risk in YukiOshi's permission system.

## Also included

- **MCP servers**: connect tools over the Model Context Protocol (`mcp` in
  config, `yukioshi mcp` to manage them and their sign-in).
- **Custom agents**: agents with their own prompt, model, and permissions
  (`agent` in config, or Markdown files in `.yukioshi/agent/`;
  `yukioshi agent create` writes one for you). Switch agents with `tab`.
- **Custom slash commands**: Markdown files in `.yukioshi/command/`.
- **LSP diagnostics and formatters**: errors from language servers are fed back
  to the agent, and edited files are formatted automatically.
- **Long sessions**: conversations are compacted automatically to stay within
  the model's context.
- **Sessions**: list, continue (`-c`, `-s`), fork, export, and import them.
  The agent can search your past conversations with the `session_search` tool
  ("what did we decide about the cache last week?"); it searches this
  project's sessions unless asked to look across all projects.
- **Headless server**: `yukioshi serve` runs YukiOshi without the terminal UI;
  `yukioshi attach <url>` connects a terminal UI to it, and `yukioshi run
  --attach <url>` sends it a prompt. Protect it with `YUKIOSHI_SERVER_PASSWORD`.
- **GitHub**: `yukioshi pr <number>` checks out a pull request and opens a
  session on it. To run YukiOshi in GitHub Actions, call `yukioshi run` from
  your own workflow (a built-in GitHub agent is not available yet).
- **Sharing**: `/share` and `run --share` only work with a share server you
  configure (`"enterprise": { "url": "…" }`). YukiOshi has no public share
  service and never uploads sessions anywhere else.
- **Editors**: `yukioshi acp` speaks the Agent Client Protocol for editors that
  support it.
