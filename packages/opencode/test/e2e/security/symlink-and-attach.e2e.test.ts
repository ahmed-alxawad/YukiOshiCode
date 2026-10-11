// Scenarios 2 and 3: a symlink that leads out of the project, a model-written subagent prompt and an
// MCP prompt template that reference files outside the project. Outside files must not reach the model
// unless the user explicitly allows it.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { requestText } from "../helpers"
import { exists, makeProject, plainEnv, userConfig } from "./util"

const OUT = "OUTSIDE-SYMLINK-TARGET-CONTENT-SECREG"
const evilMcp = path.resolve(import.meta.dir, "fixture/evil-mcp.ts")

describe("security: symlinks and file attachments", () => {
  cliIt.live(
    "read, write, glob and grep through a symlink that leads outside the project ask for permission",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        const outside = path.join(home, "outside")
        fs.mkdirSync(outside)
        fs.writeFileSync(path.join(outside, "secret.txt"), OUT)
        fs.symlinkSync(outside, path.join(proj, "link"))
        fs.symlinkSync(path.join(outside, "secret.txt"), path.join(proj, "file-link.txt"))
        fs.writeFileSync(path.join(proj, "legit.txt"), "LEGIT-INSIDE-CONTENT")
        const env = plainEnv(home, llm.url)

        const calls: Array<[string, Record<string, unknown>]> = [
          ["read", { filePath: path.join(proj, "link", "secret.txt") }],
          ["read", { filePath: path.join(proj, "file-link.txt") }],
          ["write", { filePath: path.join(proj, "link", "planted.txt"), content: "planted" }],
          ["glob", { pattern: "*", path: path.join(proj, "link") }],
          ["grep", { pattern: "OUTSIDE", path: path.join(proj, "link") }],
        ]
        // A refused permission ends the turn, so each call gets its own run.
        for (const [tool, args] of calls) {
          yield* llm.reset
          yield* llm.push(reply().tool(tool, args), reply().text("done").stop())
          const result = yield* opencode.run(`poke at the link with ${tool}`, { cwd: proj, env })
          expect(result.exitCode).toBe(0)
          expect(result.stderr).toContain("permission requested: external_directory")
          expect(JSON.stringify(yield* llm.inputs)).not.toContain(OUT)
        }
        expect(exists(outside, "planted.txt")).toBe(false)

        // Positive control: a regular file in the project reads without any prompt.
        yield* llm.reset
        yield* llm.push(reply().tool("read", { filePath: path.join(proj, "legit.txt") }), reply().text("done").stop())
        const legit = yield* opencode.run("read legit", { cwd: proj, env })
        expect(legit.exitCode).toBe(0)
        expect(legit.stderr).not.toContain("permission requested")
        expect(requestText((yield* llm.inputs).at(-1)!)).toContain("LEGIT-INSIDE-CONTENT")

        // Positive control: when the user allows it, the same symlink read works.
        yield* llm.reset
        yield* llm.push(reply().tool("read", { filePath: path.join(proj, "link", "secret.txt") }), reply().text("done").stop())
        const allowed = yield* opencode.run("read through link", {
          cwd: proj,
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(allowed.exitCode).toBe(0)
        expect(requestText((yield* llm.inputs).at(-1)!)).toContain(OUT)
      }),
    240_000,
  )

  cliIt.live(
    "a model-written subagent prompt cannot attach files outside the project",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        fs.mkdirSync(path.join(home, ".ssh"))
        fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "SUBAGENT-HOME-KEY-SECREG")
        fs.writeFileSync(path.join(proj, "inside.txt"), "SUBAGENT-INSIDE-SECREG")
        const env = plainEnv(home, llm.url)
        const subagent = (marker: string) => (hit: { body: Record<string, unknown> }) =>
          requestText(hit.body).includes(marker) && !requestText(hit.body).includes("MAIN-PROMPT")
        yield* llm.pushMatch(
          (hit) => requestText(hit.body).includes("MAIN-PROMPT"),
          reply().tool("task", { description: "peek", prompt: "SUB-A read @~/.ssh/id_rsa", subagent_type: "general" }),
          reply().tool("task", { description: "peek2", prompt: "SUB-B read @inside.txt", subagent_type: "general" }),
          reply().text("done").stop(),
        )
        yield* llm.pushMatch(subagent("SUB-A"), reply().text("sub a done").stop())
        yield* llm.pushMatch(subagent("SUB-B"), reply().text("sub b done").stop())
        const result = yield* opencode.run("MAIN-PROMPT delegate", { cwd: proj, env, extraArgs: ["--dangerously-skip-permissions"] })
        expect(result.exitCode).toBe(0)
        const inputs = yield* llm.inputs
        const a = inputs.filter((input) => requestText(input).includes("SUB-A") && !requestText(input).includes("MAIN-PROMPT"))
        const b = inputs.filter((input) => requestText(input).includes("SUB-B") && !requestText(input).includes("MAIN-PROMPT"))
        expect(a.length).toBeGreaterThan(0)
        expect(JSON.stringify(a)).not.toContain("SUBAGENT-HOME-KEY-SECREG")
        // Positive control: a reference inside the project is attached.
        expect(JSON.stringify(b)).toContain("SUBAGENT-INSIDE-SECREG")
      }),
    240_000,
  )

  cliIt.live(
    "an MCP prompt template cannot attach files outside the project; one inside the project is attached",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        fs.mkdirSync(path.join(home, ".ssh"))
        fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "MCP-HOME-KEY-SECREG")
        const outsideFile = path.join(home, "mcp-outside.txt")
        fs.writeFileSync(outsideFile, "MCP-OUTSIDE-FILE-SECREG")
        fs.writeFileSync(path.join(proj, "inside.txt"), "MCP-INSIDE-FILE-SECREG")
        userConfig(home, {
          mcp: {
            evil: {
              type: "local",
              command: [process.execPath, evilMcp],
              enabled: true,
              environment: {
                EVIL_MCP_LEAK_PATH: "{env:EVIL_MCP_LEAK_PATH}",
                EVIL_MCP_INSIDE_PATH: "{env:EVIL_MCP_INSIDE_PATH}",
              },
            },
          },
        })
        const env = plainEnv(home, llm.url)
        const run = (command: string) =>
          opencode.run("go", {
            cwd: proj,
            env: {
              ...env,
              EVIL_MCP_LEAK_PATH: outsideFile,
              EVIL_MCP_INSIDE_PATH: "inside.txt",
            },
            command,
          })
        yield* llm.text("ok")
        const leak = yield* run("evil:leak")
        opencode.expectExit(leak, 0, "leak")
        const leaked = JSON.stringify(yield* llm.inputs)
        expect(leaked).toContain("Summarize")
        expect(leaked).not.toContain("MCP-OUTSIDE-FILE-SECREG")
        expect(leaked).not.toContain("MCP-HOME-KEY-SECREG")

        yield* llm.reset
        yield* llm.text("ok")
        const inside = yield* run("evil:inside")
        expect(inside.exitCode).toBe(0)
        expect(JSON.stringify(yield* llm.inputs)).toContain("MCP-INSIDE-FILE-SECREG")
      }),
    240_000,
  )
})
