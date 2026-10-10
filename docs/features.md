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
`auto-all`, `plan`, `review`, see [Permissions and safety](permissions-and-safety.md))
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
`yukioshi run --command goal "…"` exits with 0 when the goal is done, 3 when
it needs you, and 4 when it used all its rounds (see
[exit codes](commands.md#exit-codes)). Turn it off with
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

## Review, commit, and pull requests

| Command                  | Does |
| ------------------------ | ---- |
| `/review [commit, branch, or pr]` | reviews changes in a subagent: your uncommitted work by default, or a commit, a branch, or a pull request |
| `/commit [instructions]` | commits the current changes with a message in the repository's own style |
| `/pr [base branch]`      | opens a pull request for the current branch with the GitHub CLI (`gh`) and replies with its link |

`/commit` commits what you staged, or stages only the files that belong to
the change (never `git add -A`, and never files that look like secrets). It
does not bypass commit hooks, rewrite history, or add co-author or tool
attribution unless you ask. `/pr` pushes the branch if it has no upstream yet
(never with force), writes the title and a summary, and stops instead if you
are on the base branch, have uncommitted changes, or `gh` is not signed in.
The git and `gh` commands they run follow your permission rules. From a
script: `yukioshi run --command commit`.

## Scheduled tasks

`yukioshi schedule` runs prompts on a recurring cron schedule, for example to summarize commits every morning or review dependencies weekly.

Unlike `/loop` (which runs in an active terminal session or server), scheduled tasks integrate directly into your operating system's background scheduler without running a continuous background daemon of our own:
- **Linux and macOS:** manages a clearly marked block (`# BEGIN yukioshi schedule` ... `# END yukioshi schedule`) in your user `crontab`, leaving all other cron entries untouched.
- **Windows:** registers tasks in Windows Task Scheduler via `schtasks` (under `YukiOshi\<id>`).

A job refuses every approval prompt unless it was added with `--auto`, which
approves them all, or `--review`, which has a small model approve or refuse
each action that is not low-risk (see
[review mode](permissions-and-safety.md#review-mode)).

Each execution runs like `yukioshi run` in the job's directory, creates a normal session titled `Scheduled: <name>`, writes a persistent log to `<state>/schedule/<id>/<timestamp>.log` (retaining the last 50 logs per job), and enforces a lock per job so two copies of the same job never run at the same time, even when started at the same moment. A second copy is logged as `skipped: already running`. Spending limits (`budget`) are strictly respected: if a budget limit is reached, the run is logged as `skipped: budget`.

```bash
# Add a scheduled task (standard 5-field cron)
yukioshi schedule add "0 9 * * 1-5" "summarize yesterday's commits" --name "daily-summary" --review

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

Checkpoint commands never run the repository's Git hooks or `fsmonitor`
command, whatever the repository configures. The turn number counts only the
checkpoints of that session, not commits already on your branch. Repositories
with very large Git output (tens of thousands of files) are handled: output is
no longer cut off at 1 MB.

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
own context. Running more than one subagent at a time is off by default; turn
on either way in your config:

```json
{
  "subagents": {
    "background": true,
    "parallel": true
  }
}
```

- **Background** (`subagents.background`): the agent can start a subagent in
  the background and keep working while it runs. When the subagent finishes,
  its result is sent back to the session, which then continues. In the
  terminal UI, `ctrl+b` moves subagents that are running in the foreground to
  the background. `yukioshi run` waits until every background subagent has
  reported back before it exits.
- **Parallel** (`subagents.parallel`): the `task_parallel` tool runs up to
  eight subagents, four at a time. A task with `worktree: true` runs in its own
  Git worktree on the branch `yukioshi/<task>`, with the files checked out
  before it starts, so parallel edits never collide. Afterwards, a worktree
  whose task changed nothing is removed. One with changes is kept, because
  removing it would delete the work, and the agent is told where it is. Review
  those changes, bring in what you want, then delete the worktree with
  `yukioshi worktree remove <name>`.

`YUKIOSHI_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1` and
`YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS=1` also turn these on. `subagent_depth`
(default 1) sets whether subagents may start subagents of their own.

## Background shell commands

The agent can start a long command, such as a dev server or a build, and keep
working while it runs. This is off by default:

```json
{
  "background_shell": { "enabled": true }
}
```

`YUKIOSHI_BACKGROUND_SHELL=1` also turns it on. Then the `bash` tool takes a
`background: true` option and three more tools appear:

- `bash` with `background: true` starts the command and returns a job id at
  once. It asks for the same permission as the same command in the foreground,
  and runs with the same sandbox, environment and secret masking. In review
  mode the reviewer sees the command.
- `monitor` reads the new output of a job since the last read. With `until` (a
  regular expression) it waits for a matching line, for the job to end, or for
  `timeout_seconds` (at most 600). With `match` it returns only the matching
  new lines. When the job has ended, it reports the exit code.
- `job_list` lists the jobs of the session with state, age and the last output
  lines.
- `job_stop` stops a job.

Each job keeps a rolling output buffer. When it is full, the oldest output is
dropped and `monitor` says how much. Output is masked like all other tool
output. Limits, all under `background_shell`:

| Key | Default | Meaning |
| --- | --- | --- |
| `max_jobs` | 4 | jobs that may run at once in one session |
| `max_minutes` | 30 | a job is killed after this long |
| `buffer_kb` | 1024 | output kept per job |
| `run_wait_seconds` | 60 | how long `yukioshi run` waits for running jobs |

A job runs in its own process group. Stopping, expiry, cancelling the session,
deleting the session and exiting the process kill the whole group, children
included. Jobs do not survive the session.

`yukioshi run` waits for running jobs up to `run_wait_seconds`, then kills the
rest. The final `result` event of `--format json` has a `background_jobs` object
with `started`, `finished` and `killed`.

`yukioshi tasks [--session <id>] [--format json]` lists the background jobs and
background subagents of a session. It is read-only and defaults to the latest
session. A job whose process has gone away shows as `lost`.

With the [audit log](permissions-and-safety.md#audit-log) on, start, stop and
exit of a job are recorded. The `PreToolUse` and `PostToolUse` hooks run for
`bash`, `monitor`, `job_list` and `job_stop` as for any tool.

## Web search

The `websearch` tool is off by default. Turn it on to let the agent search the
web, for example in Research mode:

```json
{
  "web_search": { "enabled": true, "provider": "exa" }
}
```

Searches go to the service you choose: `exa` (the default) or `parallel`. Both
work without an account; set `EXA_API_KEY` or `PARALLEL_API_KEY` for higher
limits. Only the search query the agent writes is sent, never your session or
files. Each search follows your `websearch` permission rules. With web search
off, the agent can still read a page with `webfetch`.

## Code navigation

With language servers on (`"lsp": true`), adding `"lsp_tool": true` gives the
agent the `lsp` tool: go to a definition or implementation, find references,
read hover information, list a file's or the project's symbols, and follow
calls in and out of a function. It is off by default.

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

### What the delegated agent can see

The agent runs in your project folder. Environment variables that look like credentials (names ending in `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, or starting with `AWS_` or `AZURE_`, your provider keys, `DATABASE_URL` and `SSH_AUTH_SOCK`) are not passed to it. If an agent needs one, set it in that agent's `env` setting. Files it reads or writes through YukiOshi must be inside the project, also when a link in the project points elsewhere.

### Permission behaviour
When the delegated agent requests permission to execute a tool (e.g. running a terminal command or editing a file), the request is forwarded to YukiOshi as an interactive permission ask. YukiOshi never auto-approves actions on the external agent's behalf. If you deny the request in YukiOshi, a rejection is returned to the external agent.

The `delegate` tool itself is classified as high-risk in YukiOshi's permission system.

## Browser automation

Browser automation is off by default. Turn it on in your configuration:

```json
{
  "browser": {
    "enabled": true,
    "headless": true,
    "engine": "chromium"
  }
}
```

- `"headless"` defaults to `true`. Set `"headless": false` to show the browser window while working.
- `"engine"` selects the browser engine (`"chrome"`, `"chromium"`, `"firefox"`, `"webkit"`, `"msedge"`). When omitted, it defaults to `"chrome"`.
- When enabled, YukiOshi registers a built-in MCP server named `browser` using Playwright (`npx -y @playwright/mcp@latest --isolated`, plus `--headless` unless `headless: false`, and `--browser <engine>` when configured).
- This equips the model with browser tools to navigate pages (`browser_browser_navigate`), take snapshots (`browser_browser_snapshot`), click elements (`browser_browser_click`), fill forms (`browser_browser_fill_form`), and evaluate page content.
- If your configuration defines its own `mcp.browser` entry, your custom entry takes precedence.

### Required installations by engine

- **Default (`chrome` or unset)**: Uses system Google Chrome. Requires root/sudo privileges to install on Linux:
  ```bash
  sudo apt install -y google-chrome-stable
  ```
- **`chromium` (recommended for unprivileged environments)**: Uses Playwright's own Chromium (Chrome for Testing). Does **not** require sudo or root privileges:
  ```bash
  npx -y @playwright/mcp@latest install-browser chromium
  ```
  *(or `npx playwright install chromium`)*
- **`firefox`**: Uses Playwright's own Firefox build. Does **not** require sudo or root privileges:
  ```bash
  npx -y @playwright/mcp@latest install-browser firefox
  ```
  *(or `npx playwright install firefox`)*
- **`webkit`**: Uses Playwright's own WebKit build. Does **not** require sudo or root privileges:
  ```bash
  npx -y @playwright/mcp@latest install-browser webkit
  ```
  *(or `npx playwright install webkit`)*
- **`msedge`**: Uses system Microsoft Edge. Requires root/sudo privileges to install on Linux:
  ```bash
  sudo apt install -y microsoft-edge-stable
  ```
- Like other executable tools, an untrusted repository's own project configuration cannot enable browser automation until explicitly trusted with `yukioshi trust .` (see [Repository trust](permissions-and-safety.md#repository-trust)).

## GitHub Actions

YukiOshi has no GitHub app; a workflow calls `yukioshi run` itself, with your
own provider key as a repository secret. This one reviews each pull request
and posts the review as a comment:

```yaml
name: YukiOshi review
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install YukiOshi Code
        run: curl -fsSL https://raw.githubusercontent.com/ahmed-alxawad/YukiOshiCode/main/install | bash
      - name: Review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          gh pr diff "$PR" | yukioshi run --model anthropic/claude-sonnet-5-5 \
            --mode plan --max-turns 30 --max-cost 2 \
            "Review this pull request diff. List bugs, risky changes, and missing tests as a short Markdown list with file and line. Read files in the repository when you need more context." \
            > review.md
          gh pr comment "$PR" --body-file review.md
```

- The installer adds `yukioshi` to the job's `PATH`. Pin a version with
  `bash -s -- --version <version>`.
- Choose the model with `--model`; YukiOshi never picks one for you. Any
  provider works through its usual environment variable.
- `--mode plan` keeps the run to low-risk actions such as reading files, so
  the review cannot change the checkout or run commands. The diff arrives on
  stdin, so no shell access is needed. (This needs 0.3.5 or later; older
  releases let `--mode plan` run actions your rules allow.)
- `--max-turns` and `--max-cost` cap the run; when one stops it, the step
  fails with exit code 5 or 6 (see [exit codes](commands.md#exit-codes)).
- The checked-out repository is not trusted, so its own YukiOshi config cannot
  run hooks, plugins, or local MCP servers, or redirect your provider (see
  [repository trust](permissions-and-safety.md#repository-trust)).
## Triggers

`POST /trigger` on `yukioshi serve` lets an external system (such as a CI job, an issue webhook, or an automation service) start an unattended YukiOshi run in an allowed directory.

Triggers are off by default. To enable them, configure `triggers` in your global `~/.config/yukioshi/yukioshi.json`:

```json
{
  "triggers": {
    "enabled": true,
    "token_env": "YUKIOSHI_TRIGGER_TOKEN",
    "directories": ["/home/user/projects/my-repo"],
    "mode": "review"
  }
}
```

- **Authentication**: Requests must send `Authorization: Bearer <token>`, compared in constant time against the environment variable specified in `token_env`. The token must be at least 32 characters long. The trigger token only grants access to `POST /trigger`, never to the rest of the server API.
- **Modes**: Runs in `"review"` (the default) or `"plan"` mode; never `"auto-all"`.
- **Request body**: JSON, at most 64 KB, with `prompt` (required), `directory` (required), and `model` (optional, `provider/model`). Other fields are rejected. A missing or wrong token gets 401, a body that is not JSON gets 415, a bad body gets 400, and a body over 64 KB gets 413.
- **Allowed directories**: The request body's `directory` must resolve to one of the directories configured in `triggers.directories` (returns 403 Forbidden otherwise). Project configs cannot enable triggers or alter allowed directories.
- **Unattended**: An approval prompt that reaches the run is refused, since no one is there to answer it.
- **Disabled**: If `triggers` is off, or `token_env` is unset, empty, or shorter than 32 characters, the endpoint returns 404 and `yukioshi serve` logs why.
- **Concurrency**: Only one run per directory at a time. A second trigger while a run is active returns 409 Conflict.
- **Async execution**: Returns `202 Accepted` immediately with `{ "sessionID": "..." }`, while the run proceeds in the background. The session is titled `Trigger: <start of the prompt>`. If the mode cannot be set on the session, nothing starts and the reply is 500.

```bash
curl -X POST http://127.0.0.1:4096/trigger \
  -H "Authorization: Bearer $YUKIOSHI_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Fix the failing test in packages/api", "directory": "/home/user/projects/my-repo"}'
```

## Claude Code plugins and marketplaces

Install skills, commands, and custom agents from Claude Code plugin repositories or marketplaces using git:

```bash
yukioshi plugin add https://github.com/example/claude-plugin.git
yukioshi plugin add https://github.com/example/claude-marketplace.git my-plugin
yukioshi plugin list
yukioshi plugin remove <name>
```

When pointing `yukioshi plugin add` at a marketplace repository (containing a `marketplace.json` or `.claude-plugin/marketplace.json`), running without a plugin name lists the available plugins in the marketplace. Providing a plugin name installs that plugin.

### Safe sandbox model

To protect your system, YukiOshi installs only non-executable parts of a Claude Code plugin:

- **Skills (`skills/`)**: installed as skills accessible to sessions and slash commands.
- **Commands (`commands/`)**: converted into YukiOshi slash commands (`$ARGUMENTS` supported).
- **Agents (`agents/`)**: converted into YukiOshi custom agents (`mode: subagent`), mapping standard attributes (`model`, `temperature`, `top_p`, etc.) and dropping unknown fields.
- **Hooks and MCP servers are never enabled**: Hooks and MCP servers run arbitrary local programs or network processes. YukiOshi blocks them unconditionally and lists them as `not installed: runs programs` alongside the command lines they would execute, so you can inspect and configure them manually if desired.
- **Safe git clone**: repositories are cloned with `--depth 1`, `--no-recurse-submodules`, git hooks disabled (`core.hooksPath=/dev/null`), protocol allowlist (`file:git:http:https:ssh`), and symbolic links removed.

## Also included

- **MCP servers**: connect tools over the Model Context Protocol (`mcp` in
  config, `yukioshi mcp` to manage them and their sign-in). Remote URLs must
  be `http` or `https`; see [MCP servers](permissions-and-safety.md#mcp-servers)
  for the other checks.
- **Custom agents**: agents with their own prompt, model, and permissions
  (`agent` in config, or Markdown files in `.yukioshi/agent/`;
  `yukioshi agent create` writes one for you). Switch agents with `tab`.
- **Custom slash commands**: Markdown files in `.yukioshi/command/`.
- **LSP diagnostics and formatters**: with `"lsp": true`, errors from language
  servers are fed back to the agent; edited files are formatted automatically.
- **Long sessions**: conversations are compacted automatically to stay within
  the model's context.
- **Sessions**: list, continue (`-c`, `-s`), fork, export, and import them.
  `yukioshi import --from claude` (or `--from codex`) brings in the newest
  Claude Code or Codex conversation held in the current folder, or name its
  `.jsonl` file. What was asked and answered is kept, and tool calls become
  short notes, so you can continue the conversation with any model.
  The agent can search your past conversations with the `session_search` tool
  ("what did we decide about the cache last week?"); it searches this
  project's sessions unless asked to look across all projects.
- **Headless server**: `yukioshi serve` runs YukiOshi without the terminal UI;
  `yukioshi attach <url>` connects a terminal UI to it, and `yukioshi run
  --attach <url>` sends it a prompt. Protect it with `YUKIOSHI_SERVER_PASSWORD`; see
  [the headless server](permissions-and-safety.md#the-headless-server).
- **GitHub**: `yukioshi pr <number>` checks out a pull request and opens a
  session on it. To run YukiOshi in GitHub Actions, call `yukioshi run` from
  your own workflow; see [GitHub Actions](#github-actions).
- **Sharing**: `/share` and `run --share` only work with a share server you
  configure (`"enterprise": { "url": "…" }`). YukiOshi has no public share
  service and never uploads sessions anywhere else.
- **Editors**: `yukioshi acp` speaks the Agent Client Protocol for editors that
  support it. No separate YukiOshi editor extension is published; connect your editor over ACP: `yukioshi acp`.
