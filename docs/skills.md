# Skills

A skill is a folder of instructions that the agent loads only when a task
needs it. Each skill has a `SKILL.md` file: YAML front matter with a `name` and
`description`, then Markdown instructions, plus any supporting files. It is
the same format Claude Code and Claude plugins use.

The agent sees every skill's name and description and loads the full
instructions with the `skill` tool when one fits. Every skill is also a slash
command in the terminal UI:

```
/nightmare src/auth
/engineering:code-review
```

## Built-in skills

| Skill | What it is for |
| ----- | -------------- |
| `nightmare` | an adversarial review that hunts for realistic, everyday failures |
| `disaster` | a review for catastrophic and cascading failures |
| `bugfix` | works through a findings report and fixes each problem with verification |
| `engineering:*` | architecture, code review, debugging, deploy checklist, documentation, incident response, standup, system design, tech debt, testing strategy |
| `design:*` | accessibility review, design critique, design handoff, design systems, research synthesis, user research, UX copy |
| `productivity:*` | memory management, getting started, task management, updates |
| `skill-creator` | create and improve skills |
| `web-artifacts-builder` | build multi-part web artifacts |
| `customize-opencode` | help with editing YukiOshi's own configuration |

The built-in skills ship inside the binary and are unpacked to
`~/.cache/yukioshi/skills/<version>/` on first use.

## Adding your own

YukiOshi looks for skills in:

1. `~/.config/yukioshi/skills/` (and `skill/`)
2. `~/.claude/skills/` and `~/.agents/skills/`
3. `.claude/skills/` and `.agents/skills/` in the project and its parent
   folders up to the repository root
4. `.yukioshi/skills/` (and `skill/`) in the project
5. folders listed in `skills.paths`, and skill indexes in `skills.urls`, in
   `yukioshi.json`

```json
{ "skills": { "paths": ["~/my-skills"] } }
```

Skills that come from the current repository are named with a `project:`
prefix (for example `project:deploy`), so a repository can never replace a
built-in or personal skill. Set `YUKIOSHI_DISABLE_CLAUDE_CODE_SKILLS=1` to skip
the `.claude` folders. Loading a skill goes through the `skill` permission, so
you can set it to `ask` or `deny` like any other tool.
