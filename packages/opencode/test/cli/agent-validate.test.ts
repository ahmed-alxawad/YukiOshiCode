import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import {
  knownModelLookup,
  modelProblem,
  scanAgentFiles,
  toolProblems,
  unknownFieldProblems,
  validateAgentFiles,
} from "../../src/cli/cmd/agent"

describe("agent validate helpers", () => {
  test("modelProblem accepts inherit and Claude aliases", () => {
    for (const alias of ["inherit", "sonnet", "opus", "haiku", "Sonnet", " INHERIT "]) {
      expect(modelProblem(alias)).toBeUndefined()
    }
  })

  test("modelProblem requires provider/model form otherwise", () => {
    expect(modelProblem("not-a-model")).toContain("invalid model")
    expect(modelProblem("provider/")).toContain("invalid model")
    expect(modelProblem("/model")).toContain("invalid model")
    expect(modelProblem("provider/model")).toBeUndefined()
  })

  test("modelProblem flags missing models only when the provider's model list is known", () => {
    const known = knownModelLookup(
      { anthropic: { models: { "claude-sonnet": {} } } },
      { test: { models: { "test-model": {} } } },
    )
    expect(modelProblem("test/test-model", known)).toBeUndefined()
    expect(modelProblem("anthropic/claude-sonnet", known)).toBeUndefined()
    expect(modelProblem("test/nope", known)).toContain("unknown model")
    expect(modelProblem("anthropic/nope", known)).toContain("unknown model")
    // Providers neither the catalog nor the config knows stay unflagged (offline/custom setups).
    expect(modelProblem("custom/whatever", known)).toBeUndefined()
  })

  test("toolProblems maps Claude tool names and flags unknown ones", () => {
    expect(toolProblems("tools", "Read, Grep, Bash")).toEqual([])
    expect(toolProblems("tools", ["WebFetch", "WebSearch", "Task", "TodoWrite"])).toEqual([])
    const problems = toolProblems("tools", "Read, NotebookEdit")
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("NotebookEdit")
    expect(problems[0]).toContain("notebookedit")
    expect(toolProblems("disallowedTools", "Write, MultiEdit")).toEqual([])
  })

  test("toolProblems reports non-string list entries without throwing", () => {
    const problems = toolProblems("tools", ["Read", 123] as unknown as string[])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("123")
  })

  test("toolProblems handles the record form with write/patch aliasing to edit", () => {
    expect(toolProblems("tools", { bash: true, write: false, edit: true, patch: false })).toEqual([])
    expect(toolProblems("tools", { bash: true, frobnicate: true })).toEqual([
      'tools key "frobnicate" is not a known permission',
    ])
  })

  test("unknownFieldProblems flags only unknown frontmatter keys", () => {
    expect(
      unknownFieldProblems({ description: "x", model: "test/test-model", tools: "Read", permissionMode: "plan" }),
    ).toEqual([])
    expect(unknownFieldProblems({ description: "x", customField: 1 })).toEqual([
      'unknown frontmatter field "customField"',
    ])
  })
})

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-validate-"))
}

function writeAgent(dir: string, file: string, lines: string[]) {
  const target = path.join(dir, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, lines.join("\n"))
  return target
}

describe("agent file scanning", () => {
  test("a valid agent file produces no problems", async () => {
    const dir = tmpdir()
    writeAgent(dir, "agent/ok.md", ["---", "description: fine", "model: sonnet", "tools: Read, Grep", "---", "Prompt"])
    const report = await validateAgentFiles([dir])
    expect(report.problems).toBe(0)
    expect(report.files).toHaveLength(1)
    expect(report.files[0].name).toBe("ok")
  })

  test("schema decode errors are reported as problems, not thrown", async () => {
    const dir = tmpdir()
    const file = writeAgent(dir, "agents/bad.md", ["---", "mode: bogus", "---", "Prompt"])
    const [report] = await scanAgentFiles([dir])
    expect(report.file).toBe(file)
    expect(report.name).toBe("bad")
    expect(report.problems.some((problem) => problem.includes("invalid frontmatter"))).toBe(true)
  })

  test("frontmatter parse errors are reported as problems, not thrown", async () => {
    const dir = tmpdir()
    // Stays invalid even after the loader's sanitize retry rewrites `description`.
    const file = writeAgent(dir, "agent/broken.md", ["---", "description: foo: bar", "- item: [oops", "---", "Prompt"])
    const [report] = await scanAgentFiles([dir])
    expect(report.file).toBe(file)
    expect(report.name).toBeUndefined()
    expect(report.problems.some((problem) => problem.includes("parse"))).toBe(true)
  })

  test("duplicate resolved names name the winning file (last directory wins)", async () => {
    const first = tmpdir()
    const second = tmpdir()
    const loser = writeAgent(first, "agents/dup.md", ["---", "description: first", "---", "A"])
    const winner = writeAgent(second, "agents/dup.md", ["---", "description: second", "---", "B"])
    const report = await validateAgentFiles([first, second])
    expect(report.problems).toBe(1)
    const entry = report.files.find((f) => f.file === loser)!
    expect(entry.problems[0]).toContain('duplicate agent name "dup"')
    expect(entry.problems[0]).toContain(winner)
    expect(report.files.find((f) => f.file === winner)!.problems).toEqual([])
  })
})

describe("yukioshi agent validate", () => {
  cliIt.live(
    "passes for valid global and project agent files",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const globalAgent = path.join(home, ".config/yukioshi/agent/reviewer.md")
        fs.mkdirSync(path.dirname(globalAgent), { recursive: true })
        fs.writeFileSync(
          globalAgent,
          [
            "---",
            "description: Reviews code",
            "mode: subagent",
            "model: test/test-model",
            "tools: Read, Grep, Glob",
            "maxTurns: 5",
            "---",
            "Review code carefully.",
          ].join("\n"),
        )

        const result = yield* opencode.spawn(["agent", "validate"])
        opencode.expectExit(result, 0, "agent validate")
        expect(result.stdout).toContain("reviewer.md")
        expect(result.stdout).toContain("ok")

        const json = yield* opencode.spawn(["agent", "validate", "--format", "json"])
        opencode.expectExit(json, 0, "agent validate --format json")
        const parsed = JSON.parse(json.stdout)
        expect(parsed.ok).toBe(true)
        expect(parsed.problems).toBe(0)
        expect(parsed.files).toHaveLength(1)
        expect(parsed.files[0].file).toBe(globalAgent)
        expect(parsed.files[0].name).toBe("reviewer")
        expect(parsed.files[0].problems).toEqual([])

        // A project agent file is discovered too when project config is enabled.
        const projectDir = path.join(home, "project")
        const projectAgent = path.join(projectDir, ".yukioshi/agents/local.md")
        fs.mkdirSync(path.dirname(projectAgent), { recursive: true })
        fs.writeFileSync(projectAgent, ["---", "description: Local agent", "---", "Do local things."].join("\n"))
        const withProject = yield* opencode.spawn(["agent", "validate"], {
          cwd: projectDir,
          env: { YUKIOSHI_DISABLE_PROJECT_CONFIG: "0" },
        })
        opencode.expectExit(withProject, 0, "agent validate (project)")
        expect(withProject.stdout).toContain("local.md")
        expect(withProject.stdout).toContain("reviewer.md")
      }),
    90_000,
  )

  cliIt.live(
    "reports problems in a Claude-style agent file and exits 1",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, ".config/yukioshi/agents/claude-style.md")
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(
          file,
          [
            "---",
            "description: Ported from Claude Code",
            "tools: Read, Grep, Bash, NotebookEdit",
            "maxTurns: 3",
            "model: sonnet",
            "permissionMode: bypassPermissions",
            "customField: whatever",
            "---",
            "You are a helpful assistant.",
          ].join("\n"),
        )

        const result = yield* opencode.spawn(["agent", "validate"])
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain("claude-style.md")
        expect(result.stdout).toContain("NotebookEdit")
        expect(result.stdout).toContain("bypassPermissions")
        expect(result.stdout).toContain("customField")
        // model: sonnet is an accepted alias, not a problem.
        expect(result.stdout).not.toContain("invalid model")

        const json = yield* opencode.spawn(["agent", "validate", "--format", "json"])
        expect(json.exitCode).toBe(1)
        const parsed = JSON.parse(json.stdout)
        expect(parsed.ok).toBe(false)
        expect(parsed.problems).toBe(3)
        const entry = parsed.files.find((f: { file: string }) => f.file === file)
        expect(entry).toBeDefined()
        expect(entry.name).toBe("claude-style")
        const problems = entry.problems.join("\n")
        expect(problems).toContain("NotebookEdit")
        expect(problems).toContain("bypassPermissions")
        expect(problems).toContain("customField")
      }),
    90_000,
  )

  cliIt.live(
    "reports duplicate agent names and which file wins",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const first = path.join(home, ".config/yukioshi/agents/dup.md")
        fs.mkdirSync(path.dirname(first), { recursive: true })
        fs.writeFileSync(first, ["---", "description: from config dir", "---", "First."].join("\n"))
        // ~/.yukioshi merges after the XDG config directory, so this file wins.
        const winner = path.join(home, ".yukioshi/agents/dup.md")
        fs.mkdirSync(path.dirname(winner), { recursive: true })
        fs.writeFileSync(winner, ["---", "description: from home dir", "---", "Second."].join("\n"))

        const result = yield* opencode.spawn(["agent", "validate"])
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain('duplicate agent name "dup"')
        expect(result.stdout).toContain(winner)

        const show = yield* opencode.spawn(["agent", "show", "dup"])
        opencode.expectExit(show, 0, "agent show dup")
        const parsed = JSON.parse(show.stdout)
        expect(parsed.name).toBe("dup")
        expect(parsed.source).toBe(winner)
        expect(parsed.description).toBe("from home dir")
      }),
    90_000,
  )
})

describe("yukioshi agent show", () => {
  cliIt.live(
    "prints the resolved agent as JSON, including the final merged permission rules",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, ".config/yukioshi/agent/reviewer.md")
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(
          file,
          [
            "---",
            "description: Reviews code",
            "mode: subagent",
            "model: test/test-model",
            "maxTurns: 7",
            "permission:",
            "  bash: deny",
            "---",
            "Review code.",
          ].join("\n"),
        )

        const result = yield* opencode.spawn(["agent", "show", "reviewer"])
        opencode.expectExit(result, 0, "agent show")
        const parsed = JSON.parse(result.stdout)
        expect(parsed.name).toBe("reviewer")
        expect(parsed.source).toBe(file)
        expect(parsed.description).toBe("Reviews code")
        expect(parsed.mode).toBe("subagent")
        expect(parsed.model).toBe("test/test-model")
        expect(parsed.steps).toBe(7)
        // Final merged ruleset: the file's bash deny survives alongside the built-in defaults.
        expect(parsed.permission).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
        expect(parsed.permission).toContainEqual({ permission: "doom_loop", pattern: "*", action: "ask" })
      }),
    90_000,
  )

  cliIt.live(
    "fails for an unknown agent",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["agent", "show", "no-such-agent"])
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("no-such-agent")
        expect(result.stderr.toLowerCase()).toContain("unknown agent")
      }),
    60_000,
  )
})
