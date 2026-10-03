# Hooks

Hooks run your own shell commands at fixed points in the agent's work: to
check a command before it runs, format files after an edit, add context to a
prompt, or send a notification. They follow the same conventions as Claude Code
hooks, so many existing hook scripts work unchanged.

## Events

| Event              | Runs                                              | Can block it?                         |
| ------------------ | ------------------------------------------------- | ------------------------------------- |
| `preToolUse`       | before a tool call, before the permission check   | yes                                   |
| `postToolUse`      | after a tool call                                 | the call already ran; a block is sent to the model as feedback |
| `userPromptSubmit` | before your message is sent                       | yes; standard output is added as context |
| `sessionStart`     | when a session starts                             | no; standard output is added as context |
| `stop`             | when a task completes                             | no                                    |
| `notification`     | when the agent is waiting for your approval       | no                                    |

## Configuration

```json
{
  "hooks": {
    "preToolUse": [{ "matcher": "bash", "command": "./scripts/check-command.sh" }],
    "postToolUse": [{ "matcher": "edit|write|apply_patch", "command": "npx prettier --write .", "timeoutMs": 30000 }],
    "notification": [{ "command": "notify-send 'YukiOshi Code' 'Waiting for approval'" }]
  }
}
```

Each event takes a list of hooks, run one after another:

| Field       | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `command`   | the command line; runs with `$SHELL` (or `/bin/sh`) on macOS and Linux, `cmd.exe` on Windows |
| `matcher`   | optional regular expression matched against the whole tool id, such as `bash`, `edit`, `write`, `read`, `webfetch`; omit it or use `*` for every tool |
| `timeoutMs` | optional; default 60000                                                 |

## What a hook receives

Event data arrives as JSON on standard input. It always includes
`hook_event_name` and `cwd`; tool events add `tool_name`, `tool_input`,
`tool_use_id`, and `session_id`, and `userPromptSubmit` adds `prompt`.

Every hook also gets two environment variables:

- `YUKIOSHI_PROJECT_DIR`: the project folder
- `YUKIOSHI_HOOK_EVENT`: the event name

## Blocking

A hook blocks the action by exiting with code `2`, or by printing
`{"decision":"block","reason":"…"}`. The reason is shown to the model so it
can adjust.

```bash
#!/bin/sh
# scripts/check-command.sh: refuse commands that touch production
input=$(cat)
case "$input" in
  *production*) echo '{"decision":"block","reason":"Do not touch production from here."}' ;;
esac
```

## Hooks in repositories

Hooks defined by a repository (in its `yukioshi.json` or `.yukioshi/`) run only
after you trust the repository with `yukioshi trust .`, and stop again if they
change. Hooks in your global config always run. See
[Permissions and safety](permissions-and-safety.md#repository-trust).
