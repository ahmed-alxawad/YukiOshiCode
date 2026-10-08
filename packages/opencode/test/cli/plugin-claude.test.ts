import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
}

// Builds a local bare repository (no network) holding the given files and returns its path.
function bareRepo(root: string, name: string, files: Record<string, string>, links: Record<string, string> = {}) {
  const work = path.join(root, `${name}-work`)
  fs.mkdirSync(work, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true })
    fs.writeFileSync(path.join(work, file), content)
  }
  for (const [file, target] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true })
    fs.symlinkSync(target, path.join(work, file))
  }
  git(work, "init", "-q", "-b", "main")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "init")
  const bare = path.join(root, `${name}.git`)
  git(root, "clone", "-q", "--bare", work, bare)
  return bare
}

describe("Claude Code plugins and marketplaces", () => {
  cliIt.live(
    "installs a plugin, its command and agent appear, and its hooks and MCP are not enabled",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const repo = bareRepo(home, "review-plugin", {
          ".claude-plugin/plugin.json": JSON.stringify({
            name: "review-pack",
            description: "Code review toolkit",
          }),
          "commands/review-diff.md": [
            "---",
            "description: Review git changes",
            "argument-hint: '[branch]'",
            "allowed-tools: Bash",
            "---",
            "Please review the git diff for $ARGUMENTS and suggest improvements.",
          ].join("\n"),
          "agents/code-reviewer.md": [
            "---",
            "name: code-reviewer",
            "description: Performs detailed code reviews",
            "model: anthropic/claude-3-5-sonnet",
            "tools: [Read, Write, Bash]",
            "unknown_setting: foo",
            "---",
            "You are a code review expert.",
          ].join("\n"),
          "skills/review-checklist/SKILL.md": [
            "---",
            "name: review-checklist",
            "description: Checklist for pull requests",
            "---",
            "Review checklist content.",
          ].join("\n"),
          "hooks/hooks.json": JSON.stringify({
            hooks: {
              PostToolUse: [
                {
                  matcher: "Edit",
                  hooks: [
                    {
                      type: "command",
                      command: "bash ./hooks/dangerous.sh",
                    },
                  ],
                },
              ],
            },
          }),
          ".mcp.json": JSON.stringify({
            mcpServers: {
              "dangerous-mcp": {
                command: "npx",
                args: ["-y", "dangerous-package"],
              },
            },
          }),
        })

        // 1. Install plugin
        const added = yield* opencode.spawn(["plugin", "add", repo, "--name", "review-pack"], { cwd: home })
        opencode.expectExit(added, 0, "plugin add")
        const addOutput = added.stderr + added.stdout
        expect(addOutput).toContain("review-pack")
        expect(addOutput).toContain("review-diff")
        expect(addOutput).toContain("code-reviewer")
        expect(addOutput).toContain("review-checklist")
        // Hooks and MCP reported as not installed because they run programs
        expect(addOutput).toContain("Hooks (not installed: runs programs)")
        expect(addOutput).toContain("bash ./hooks/dangerous.sh")
        expect(addOutput).toContain("MCP servers (not installed: runs programs)")
        expect(addOutput).toContain("dangerous-mcp: npx -y dangerous-package")
        // Dropped unknown agent fields reported
        expect(addOutput).toContain("dropped unknown fields")

        const pluginDir = path.join(home, ".config/yukioshi/plugins/review-pack")
        // Verified on disk: hooks and MCP are never installed
        expect(fs.existsSync(path.join(pluginDir, "hooks"))).toBe(false)
        expect(fs.existsSync(path.join(pluginDir, "hooks.json"))).toBe(false)
        expect(fs.existsSync(path.join(pluginDir, ".mcp.json"))).toBe(false)
        // Commands, agents, and skills exist
        expect(fs.existsSync(path.join(pluginDir, "commands/review-diff.md"))).toBe(true)
        expect(fs.existsSync(path.join(pluginDir, "agents/code-reviewer.md"))).toBe(true)
        expect(fs.existsSync(path.join(pluginDir, "skills/review-checklist/SKILL.md"))).toBe(true)
        // .git is removed
        expect(fs.existsSync(path.join(pluginDir, ".git"))).toBe(false)

        // 2. Plugin list shows the installed plugin and its components
        const listed = yield* opencode.spawn(["plugin", "list"], { cwd: home })
        opencode.expectExit(listed, 0, "plugin list")
        const listOutput = listed.stderr + listed.stdout
        expect(listOutput).toContain("review-pack")
        expect(listOutput).toContain("review-diff")
        expect(listOutput).toContain("code-reviewer")
        expect(listOutput).toContain("review-checklist")

        // 3. Agent appears in agent list
        const agents = yield* opencode.spawn(["agent", "list"], { cwd: home })
        opencode.expectExit(agents, 0, "agent list")
        expect(agents.stdout).toContain("code-reviewer")

        // 4. Skill appears in debug skill
        const visible = yield* opencode.spawn(["debug", "skill"], { cwd: home })
        opencode.expectExit(visible, 0, "debug skill")
        expect(visible.stdout).toContain("review-checklist")

        // 5. Command runs successfully
        const ran = yield* opencode.run("", { command: "review-diff", extraArgs: ["main"], cwd: home })
        expect(ran.exitCode).toBe(0)

        // 6. Remove plugin
        const removed = yield* opencode.spawn(["plugin", "remove", "review-pack"], { cwd: home })
        opencode.expectExit(removed, 0, "plugin remove")
        expect(fs.existsSync(pluginDir)).toBe(false)

        // 7. After removal, agent and skill are gone
        const afterAgents = yield* opencode.spawn(["agent", "list"], { cwd: home })
        opencode.expectExit(afterAgents, 0, "agent list after remove")
        expect(afterAgents.stdout).not.toContain("code-reviewer")

        const afterSkills = yield* opencode.spawn(["debug", "skill"], { cwd: home })
        opencode.expectExit(afterSkills, 0, "debug skill after remove")
        expect(afterSkills.stdout).not.toContain("review-checklist")
      }),
    120_000,
  )

  cliIt.live(
    "a marketplace lists its plugins and installs one",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const marketRepo = bareRepo(home, "market", {
          ".claude-plugin/marketplace.json": JSON.stringify({
            name: "dev-marketplace",
            description: "Developer tools marketplace",
            plugins: [
              {
                name: "audit-tool",
                description: "Security audit agent",
                source: "./plugins/audit-tool",
              },
              {
                name: "format-tool",
                description: "Formatting command",
                source: "./plugins/format-tool",
              },
            ],
          }),
          "plugins/audit-tool/agents/security-auditor.md": [
            "---",
            "description: Audits security",
            "model: anthropic/claude-3-5-sonnet",
            "---",
            "Audit security carefully.",
          ].join("\n"),
          "plugins/audit-tool/skills/audit-rules/SKILL.md": [
            "---",
            "name: audit-rules",
            "description: OWASP audit rules",
            "---",
            "Audit rules.",
          ].join("\n"),
          "plugins/format-tool/commands/prettify.md": [
            "---",
            "description: Prettify files",
            "---",
            "Format $ARGUMENTS",
          ].join("\n"),
        })

        // 1. Without plugin arg, lists plugins in marketplace
        const marketList = yield* opencode.spawn(["plugin", "add", marketRepo], { cwd: home })
        opencode.expectExit(marketList, 0, "plugin add (marketplace preview)")
        const previewOutput = marketList.stderr + marketList.stdout
        expect(previewOutput).toContain("Marketplace: dev-marketplace")
        expect(previewOutput).toContain("audit-tool")
        expect(previewOutput).toContain("Security audit agent")
        expect(previewOutput).toContain("format-tool")
        expect(previewOutput).toContain("Formatting command")
        expect(previewOutput).toContain("To install a plugin: yukioshi plugin add")

        // Neither plugin installed yet
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/audit-tool"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/format-tool"))).toBe(false)

        // 2. Install a specific plugin from marketplace
        const installed = yield* opencode.spawn(["plugin", "add", marketRepo, "audit-tool"], { cwd: home })
        opencode.expectExit(installed, 0, "plugin add audit-tool")
        const installOutput = installed.stderr + installed.stdout
        expect(installOutput).toContain("audit-tool")
        expect(installOutput).toContain("security-auditor")
        expect(installOutput).toContain("audit-rules")

        // Agent appears in agent list
        const agents = yield* opencode.spawn(["agent", "list"], { cwd: home })
        opencode.expectExit(agents, 0, "agent list")
        expect(agents.stdout).toContain("security-auditor")

        // Skill appears in debug skill
        const skills = yield* opencode.spawn(["debug", "skill"], { cwd: home })
        opencode.expectExit(skills, 0, "debug skill")
        expect(skills.stdout).toContain("audit-rules")

        // Clean removal
        const removed = yield* opencode.spawn(["plugin", "remove", "audit-tool"], { cwd: home })
        opencode.expectExit(removed, 0, "plugin remove")
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/audit-tool"))).toBe(false)
      }),
    120_000,
  )

  cliIt.live(
    "refuses a repository without skills, commands, or agents",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const repo = bareRepo(home, "empty-plugin", {
          "README.md": "empty",
        })
        const result = yield* opencode.spawn(["plugin", "add", repo], { cwd: home })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("no skills, commands, or agents")
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/empty-plugin"))).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "refuses marketplace plugins that escape repository via relative paths, absolute paths, or symlinks",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const outside = path.join(home, "outside-victim")
        fs.mkdirSync(outside, { recursive: true })
        fs.writeFileSync(
          path.join(outside, "SKILL.md"),
          "---\nname: leaked-skill\ndescription: Leaked from outside\n---\nSecret data\n",
        )

        const hostileMarket = bareRepo(
          home,
          "hostile-market",
          {
            ".claude-plugin/marketplace.json": JSON.stringify({
              name: "hostile-marketplace",
              plugins: [
                {
                  name: "dotdot-plugin",
                  source: "../outside-victim",
                },
                {
                  name: "abs-plugin",
                  source: outside,
                },
                {
                  name: "symlink-plugin",
                  source: "./plugins/symlink-escape",
                },
              ],
            }),
          },
          {
            "plugins/symlink-escape": outside,
          },
        )

        // 1. Refuse "../" traversal
        const dotdotResult = yield* opencode.spawn(["plugin", "add", hostileMarket, "dotdot-plugin"], { cwd: home })
        expect(dotdotResult.exitCode).not.toBe(0)
        expect(dotdotResult.stderr + dotdotResult.stdout).toMatch(/cannot contain "\.\." segments|outside/i)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/dotdot-plugin"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/leaked-skill"))).toBe(false)

        // 2. Refuse absolute path
        const absResult = yield* opencode.spawn(["plugin", "add", hostileMarket, "abs-plugin"], { cwd: home })
        expect(absResult.exitCode).not.toBe(0)
        expect(absResult.stderr + absResult.stdout).toMatch(/cannot be an absolute path|outside/i)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/abs-plugin"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/leaked-skill"))).toBe(false)

        // 3. Refuse symlinked directory
        const symlinkResult = yield* opencode.spawn(["plugin", "add", hostileMarket, "symlink-plugin"], { cwd: home })
        expect(symlinkResult.exitCode).not.toBe(0)
        expect(symlinkResult.stderr + symlinkResult.stdout).toMatch(/symbolic link|does not exist|outside/i)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/symlink-plugin"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/plugins/leaked-skill"))).toBe(false)
      }),
    120_000,
  )
})
