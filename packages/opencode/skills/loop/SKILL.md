---
name: loop
description: How to repeat a prompt or slash command with /loop, let the agent pace itself, and when to use yukioshi schedule instead. Use when asked to poll, babysit, check something every few minutes, or keep re-running a task.
---

# Using /loop

`/loop` repeats a prompt or a slash command in the current session.

- `/loop 5m check whether CI passed` runs now, then every 5 minutes (`90s`, `5m`, `1h30m`).
- `/loop check whether CI passed` has no interval, so you pick the delay: at the end of each run call the `loop_wait` tool with `seconds` and a short `reason`, or `stop: true` when the work is finished. Wait longer when nothing is changing, shorter when something is about to. With no call, the next run follows in 10 minutes.
- `/loop` shows the state, `/loop stop` ends it.

Safety rails: delays stay between `loop.min_interval` (60 s) and 1 hour in self-paced mode, a loop stops after `loop.max_runs` runs (50), when a run fails, or when you interrupt it, and there is one loop per session. Set `"loop": { "enabled": false }` to turn it off.

## When not to use it

A loop lives only as long as this terminal session. For recurring work that must survive closing the terminal or a reboot, use `yukioshi schedule` (an operating system scheduled task) instead.

Keep each run small and idempotent: check, report only what changed, then stop or wait.
