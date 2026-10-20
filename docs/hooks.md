# Hooks

Hooks run your own shell commands, or call your own HTTP endpoint, at fixed
points in the agent's work: to check a command before it runs, format files
after an edit, add context to a prompt, or send a notification. They follow the
same conventions as Claude Code hooks, so many existing hook scripts work
unchanged.

## Events

| Event              | Runs                                              | Can block it?                         |
| ------------------ | ------------------------------------------------- | ------------------------------------- |
| `preToolUse`       | before a tool call, before the permission check   | yes                                   |
| `postToolUse`      | after a tool call                                 | the call already ran; a block is sent to the model as feedback |
| `userPromptSubmit` | before your message is sent                       | yes; standard output is added as context |
| `sessionStart`     | before the first message of a session             | no; standard output is added as context |
| `stop`             | when a task completes                             | no                                    |
| `subagentStart`    | when a subagent session starts                    | no                                    |
| `subagentStop`     | when a subagent finishes its task                 | no                                    |
| `preCompact`       | before a long conversation is compacted           | no                                    |
| `notification`     | when the agent is waiting for your approval (`matcher` is matched against the permission name) | no |

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

For an HTTP hook, see [HTTP hooks](#http-hooks) below.

## What a hook receives

Event data arrives as JSON on standard input. It always includes
`hook_event_name` and `cwd`; tool events add `tool_name`, `tool_input`,
`tool_use_id`, and `session_id`; `postToolUse` also adds `tool_response`
(`title`, `output`, `metadata`). `userPromptSubmit` has `session_id` and `prompt`,
`sessionStart` has `session_id` and `source`, and `notification` has `session_id`,
`message`, `tool_name` (the permission asked for) and `risk`.
`subagentStart` has `session_id`, `parent_session_id`, `agent_name` and `description` (the task
description), and `subagentStop` has `session_id` and `parent_session_id`, and `preCompact` has
`session_id` and `trigger` (`auto`, or `manual` when you asked for it).
`stop` has `session_id` and runs only for the session you started; a subagent
finishing runs `subagentStop` instead.

Every hook also gets two environment variables:

- `YUKIOSHI_PROJECT_DIR`: the project folder
- `YUKIOSHI_HOOK_EVENT`: the event name

Hooks do not inherit credentials from your environment. Variables named
`DATABASE_URL`, `PASSWORD`, or `PASSWD`, and variables ending in `_PASSWORD`,
`_PASSWD`, `_PRIVATE_KEY`, `_ACCESS_KEY`, `_SECRET_KEY`, `_SECRET_ACCESS_KEY`,
`_SECRET`, `_TOKEN`, or `_API_KEY`, are removed before a hook runs. The JSON a
hook receives and the output it prints are secret-masked, so credentials that
appear in a prompt or tool output are replaced with `[REDACTED:...]`.

## Blocking

A hook blocks the action by exiting with code `2`, or by printing
`{"decision":"block","reason":"…"}`. The reason is shown to the model so it
can adjust. Only `preToolUse` and `userPromptSubmit` can stop anything; a block
from any other event is ignored (`postToolUse` sends it to the model as feedback).
A hook can also print `{"additionalContext":"…"}` to add context (`userPromptSubmit` and `sessionStart`).

```bash
#!/bin/sh
# scripts/check-command.sh: refuse commands that touch production
input=$(cat)
case "$input" in
  *production*) echo '{"decision":"block","reason":"Do not touch production from here."}' ;;
esac
```

## HTTP hooks

An HTTP hook sends the same JSON a command hook gets on standard input as the
body of a `POST` request (`content-type: application/json`). There are none
unless you add one.

```json
{
  "hooks": {
    "preToolUse": [
      {
        "type": "http",
        "url": "https://hooks.example.com/yukioshi",
        "headers": { "Authorization": "Bearer $HOOK_TOKEN" },
        "allowedEnvVars": ["HOOK_TOKEN"],
        "matcher": "bash"
      }
    ]
  }
}
```

| Field                 | Meaning                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `type`                | `http`                                                                  |
| `url`                 | the endpoint; must start with `http://` or `https://`                   |
| `headers`             | optional request headers                                                |
| `allowedEnvVars`      | optional; the environment variables `headers` may use as `$NAME` or `${NAME}`. A reference to any other variable becomes empty |
| `allowPrivateAddress` | optional; lets the hook reach a private or local address (see below). Only honoured in your global config |
| `matcher`             | as for command hooks                                                    |
| `timeoutMs`           | optional; default 5000. The whole request, from looking up the address to reading the response, must finish in this time |

The response is read like a command hook's standard output when the hook exits
with code `0`: a `2xx` response with `{"decision":"block","reason":"…"}` (or
`hookSpecificOutput.permissionDecision: "deny"`) blocks the action where a
command hook can block it, and a plain-text body is added as context for
`userPromptSubmit` and `sessionStart`. There is no equivalent of exit code `2`:
any other status, a redirect (redirects are not followed), a response larger
than 64 KiB, a connection failure, or a timeout is a failed hook. A failed HTTP
hook shows a warning and never blocks the action.

**Private and local addresses.** By default an HTTP hook is not sent to a
loopback, private, link-local, carrier-grade NAT, multicast, or reserved
address (such as `127.0.0.1`, `10.0.0.0/8`, `192.168.0.0/16`,
`169.254.169.254`, `fc00::/7`, or `::1`), including a host name that resolves
to one; the hook fails with a warning and nothing is sent. The request goes only
to the addresses that were checked. To send to a local service, add
`"allowPrivateAddress": true` to the hook in your global config
(`~/.config/yukioshi/yukioshi.json`). The setting has no effect in a project's
config: there it applies only if your global config has an HTTP hook for the
same event and URL with `allowPrivateAddress`.

**Secrets.** Write credentials as `$NAME` in `headers` and list `NAME` in
`allowedEnvVars`; nothing else from your environment is read. Header values
are masked if they would be shown (for example, a server that repeats one in a
block reason), and warnings name only the scheme and host of the URL, not its
path or query string, which often hold a token. The JSON that is sent is
secret-masked, as for command hooks.

## Hooks in repositories

Hooks defined by a repository (in its `yukioshi.json` or `.yukioshi/`) run only
after you trust the repository with `yukioshi trust .`, and stop again if they
change. This includes HTTP hooks: an untrusted repository cannot add one.
Hooks in your global config always run. An agent can also carry its own
`preToolUse`, `postToolUse` and `stop` hooks in its frontmatter (see
[Subagents](features.md)); they run only in that agent's sessions, after the
global ones, and are ignored for agents from an untrusted repository or a
Claude plugin. See
[Permissions and safety](permissions-and-safety.md#repository-trust).
