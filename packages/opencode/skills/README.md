# Built-in skills

Skills are folders with a `SKILL.md` file (YAML front matter with `name` and
`description`, then Markdown instructions) plus optional supporting files. They
use the same format as Claude Code and Claude plugins. YukiOshi lists every
skill by name and description in the system prompt and loads the full
instructions only when a task needs them (the `use_skill` tool). In a session
you can also call one directly: `/nightmare src/auth`.

## Purpose

The skills shipped with YukiOshi Code, copied next to the CLI and the VS Code
extension at build time (`dist/skills`) and loaded as the `builtin` source.

## Owns

| Folder                               | Skills                                                                                                                                                                                                                                                                                | Origin and license                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `design/`                            | `design:accessibility-review`, `design:design-critique`, `design:design-handoff`, `design:design-system`, `design:research-synthesis`, `design:user-research`, `design:ux-copy`                                                                                                       | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (design plugin 1.2.0), Apache-2.0 |
| `engineering/`                       | `engineering:architecture`, `engineering:code-review`, `engineering:debug`, `engineering:deploy-checklist`, `engineering:documentation`, `engineering:incident-response`, `engineering:standup`, `engineering:system-design`, `engineering:tech-debt`, `engineering:testing-strategy` | knowledge-work-plugins (engineering plugin 1.2.0), Apache-2.0                                                               |
| `productivity/`                      | `productivity:memory-management`, `productivity:start`, `productivity:task-management`, `productivity:update`                                                                                                                                                                         | knowledge-work-plugins (productivity plugin 1.3.1), Apache-2.0; two path references adapted (see `NOTICE`)                  |
| `skill-creator/`                     | `skill-creator`                                                                                                                                                                                                                                                                       | Anthropic example skill, Apache-2.0 (`skill-creator/LICENSE.txt`)                                                           |
| `web-artifacts-builder/`             | `web-artifacts-builder`                                                                                                                                                                                                                                                               | Anthropic example skill, Apache-2.0 (`web-artifacts-builder/LICENSE.txt`)                                                   |
| `nightmare/`, `disaster/`, `bugfix/` | `nightmare`, `disaster`, `bugfix`                                                                                                                                                                                                                                                     | Written for YukiOshi Code, Apache-2.0 (this repository's license)                                                           |

`LICENSES/Apache-2.0.txt` holds the license text; `NOTICE` holds attributions.

### Not bundled, but usable

- **Anthropic document skills** (`docx`, `pdf`, `pptx`, `xlsx`) are proprietary
  and may not be redistributed. If you have them (for example in
  `~/.claude/skills`), YukiOshi reads them from there automatically
  (`skills.claudeInterop`), or install a copy you are licensed to use with
  `yukioshi skills add <folder>`.
- **Plugin skills from other vendors** (for example Qodo) are read from
  `~/.claude/plugins` when installed there.
- **Claude app–specific skills** (Claude Docs, memory import, morning brief)
  depend on claude.ai connectors and do not apply to a coding agent.

## Does Not Own

Skill discovery, precedence, and loading (`packages/skills`), the `use_skill`
tool (`packages/tooling`), and user or repository skills
(`<user data>/skills`, `.yukioshi/skills`, `.claude/skills`).

## Public Boundary

Folder layout: `<skill>/SKILL.md` or `<namespace>/<skill>/SKILL.md` (namespace
folders become `namespace:skill`). A user skill with the same name replaces a
built-in one; disable any skill with `skills.disabled`.

## Dependencies

None at runtime. `scripts/build.mjs` copies this folder into each bundle.

## Testing

`packages/skills/test` covers parsing and discovery; `apps/cli/test` checks that
the bundle contains these skills.

## Maintainer Notes

Only add skills whose license allows redistribution, keep their license file
inside the skill folder or in `LICENSES/`, and record the origin in the table
above and in `NOTICE`. Keep `SKILL.md` front matter valid: `yukioshi skills
issues` reports problems.
