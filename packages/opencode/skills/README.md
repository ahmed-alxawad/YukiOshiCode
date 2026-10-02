# Built-in skills

A skill is a folder with a `SKILL.md` file (YAML front matter with `name` and
`description`, then Markdown instructions) plus optional supporting files. The
format is the same one Claude Code and Claude plugins use.

YukiOshi lists every available skill by name and description, and the model
loads a skill's full instructions with the `skill` tool only when a task needs
it. Every skill is also a slash command in the TUI, for
example `/nightmare src/auth` or `/engineering:code-review`.

## What ships here

| Folder                               | Skills                                                                                                                                                                                                                                                                                | Origin and license                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `nightmare/`, `disaster/`, `bugfix/` | `nightmare`, `disaster`, `bugfix`                                                                                                                                                                                                                                                     | Written for YukiOshi Code, Apache-2.0                                                                                       |
| `engineering/`                       | `engineering:architecture`, `engineering:code-review`, `engineering:debug`, `engineering:deploy-checklist`, `engineering:documentation`, `engineering:incident-response`, `engineering:standup`, `engineering:system-design`, `engineering:tech-debt`, `engineering:testing-strategy` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (engineering 1.2.0), Apache-2.0   |
| `design/`                            | `design:accessibility-review`, `design:design-critique`, `design:design-handoff`, `design:design-system`, `design:research-synthesis`, `design:user-research`, `design:ux-copy`                                                                                                       | knowledge-work-plugins (design 1.2.0), Apache-2.0                                                                           |
| `productivity/`                      | `productivity:memory-management`, `productivity:start`, `productivity:task-management`, `productivity:update`                                                                                                                                                                         | knowledge-work-plugins (productivity 1.3.1), Apache-2.0; two file references adapted (see `NOTICE`)                         |
| `skill-creator/`                     | `skill-creator`                                                                                                                                                                                                                                                                       | Anthropic example skill, Apache-2.0 (`skill-creator/LICENSE.txt`)                                                           |
| `web-artifacts-builder/`             | `web-artifacts-builder`                                                                                                                                                                                                                                                               | Anthropic example skill, Apache-2.0 (`web-artifacts-builder/LICENSE.txt`)                                                   |

`customize-opencode` (help with editing YukiOshi's own configuration) is also
built in, but its content lives in `packages/core/src/plugin/skill`.

`LICENSES/Apache-2.0.txt` holds the license text and `NOTICE` holds the
attributions. `CONNECTORS.md` explains the `~~connector` placeholders used by
the plugin-derived skills: YukiOshi has no connectors, so those skills fall
back to local tools or ask the user.

## How the binary carries them

When running from source, skills are read from this folder directly. The
release build (`script/build.ts`) embeds every file here into the binary, and
on first use they are extracted to `<cache>/yukioshi/skills/<version>/`
(for example `~/.cache/yukioshi/skills/0.3.0/` on Linux).

## Adding your own skills

Skills are discovered from, in order:

1. this built-in folder;
2. `~/.claude/skills/` and `~/.agents/skills/`;
3. `.claude/skills/` and `.agents/skills/` in the project and its parent
   directories up to the repository root;
4. `skill/` or `skills/` inside YukiOshi config directories
   (`~/.config/yukioshi/`, the project's `.yukioshi/`);
5. extra folders listed in `skills.paths` and remote indexes in `skills.urls`
   in `yukioshi.json`.

Skills that belong to the current repository are exposed with a `project:`
prefix (`project:deploy`), so a repository can never shadow a built-in or
personal skill. Set `YUKIOSHI_DISABLE_CLAUDE_CODE_SKILLS=1` to skip the
`.claude` folders. Loading a skill goes through the `skill` permission, so it
can be set to `ask` or `deny` like any other tool.
