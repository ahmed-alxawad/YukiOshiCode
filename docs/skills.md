# Skills

A skill is a folder of instructions that the agent loads only when a task
needs it. Each skill has a `SKILL.md` file: YAML front matter with a `name` and
`description`, then Markdown instructions, plus any supporting files. It is
the same format Claude Code and Claude plugins use.

The agent sees every skill's name and description and loads the full
instructions with the `skill` tool when one fits. That list goes into every
request, so descriptions longer than 300 characters are shortened in it (the
full text is used when the skill loads); put the trigger words first. Every skill is also a slash
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

## Installing skills from git

```bash
yukioshi skill add https://github.com/example/skills.git           # name defaults to the repository name
yukioshi skill add git@github.com:example/skills.git --name team   # choose the folder name
yukioshi skill list                                                 # installed sources and their URLs
yukioshi skill remove team
```

`skill add` clones the repository (`git clone --depth 1`) into
`~/.config/yukioshi/skills/<name>/`, so its skills are available in every
project. The repository needs a `SKILL.md`, at its root or in sub-folders (one
skill per folder that has one), and the command prints the skill names it
found. It refuses a repository without one.

A skill is only Markdown, so nothing from the repository is ever run: git
hooks are disabled, the `.git` folder is deleted after cloning, and symbolic
links are removed so a skill cannot point at files elsewhere on your machine.
Only folders installed this way can be removed with `skill remove`; folders you
wrote yourself are never touched. To update a skill, remove it and add it
again. Skills can still tell the model what to do, so install only from
sources you trust.

If skills are packaged inside a Claude Code plugin or marketplace alongside commands and agents, you can install them using `yukioshi plugin add` (see [Claude Code plugins and marketplaces](features.md#claude-code-plugins-and-marketplaces)).

## Skills YukiOshi writes itself

Off by default. Turn it on and YukiOshi can save a procedure it worked out
(a release process, the fix for a recurring build problem, a project-specific
workflow) as a skill of its own, and load it in later sessions:

```json
{ "skills": { "learn": true } }
```

Learned skills are kept in YukiOshi's data folder
(`~/.local/share/yukioshi/skills/learned/`), never in your project, and are
listed like any other skill from the next session. Saving goes through the
`skill_save` permission, so set it to `ask` to approve each one.

A curator keeps the set small and useful:

- A new skill that repeats an existing one under another name is refused, and
  YukiOshi is told to update the existing skill instead.
- A skill nobody has loaded for `stale_days` (default 90) is retired.
- Beyond `max` skills (default 30), the least used are retired.

Retired and replaced skills move to `learned/.archive/`, so nothing is deleted;
move a folder back to restore it. Set the limits with
`{ "skills": { "learn": { "enabled": true, "max": 30, "stale_days": 90 } } }`.
