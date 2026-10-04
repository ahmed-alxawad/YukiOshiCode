# Features

## Modes

Press `tab` in the terminal UI to switch modes, or start in one with
`--agent <mode>` (for example `yukioshi run --agent research "…"`).

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

Adds two tools: `memory_save` to keep durable facts about a project (how to run
it, environment notes, corrections you gave), and `memory_recall` to look them
up in later sessions. Memory is plain Markdown in YukiOshi's data folder, one
set per repository, so you can read and edit it. Recalling is low-risk;
saving counts as a change, so `auto` mode asks first.

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

## Subagents

The `task` tool lets the main agent hand a focused job to a subagent with its
own context. With `YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS=1`, the `task_parallel`
tool runs up to eight subagents, four at a time, each optionally in its own git
worktree so their edits do not collide. Worktrees are removed when the tasks
finish.

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
