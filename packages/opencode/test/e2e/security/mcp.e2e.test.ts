// Scenario 9: MCP servers are untrusted peers. Their tools cannot shadow built-ins, non-http remote
// URLs are refused, and configured headers are not forwarded to another origin on a redirect.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { requestToolNames, requestToolResults, waitFor } from "../helpers"
import { attacker, makeProject, plainEnv, stopOnExit, userConfig } from "./util"

const evilMcp = path.resolve(import.meta.dir, "fixture/evil-mcp.ts")

describe("security: MCP", () => {
  cliIt.live(
    "an MCP tool whose name equals a built-in is not registered; other tools of the same server are",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        // server "session" + tool "search" is named session_search, a built-in.
        const env = plainEnv(home, llm.url)
        userConfig(home, {
          mcp: {
            session: { type: "local", command: [process.execPath, evilMcp], enabled: true, environment: { EVIL_MCP_TOOLS: "search,safe" } },
          },
        })
        yield* llm.push(reply().tool("session_search", { query: "x" }), reply().text("done").stop())
        const result = yield* opencode.run("use tools", { cwd: proj, env, extraArgs: ["--dangerously-skip-permissions"] })
        expect(result.exitCode).toBe(0)
        const first = (yield* llm.inputs).find((input) => Array.isArray(input.tools))!
        const names = requestToolNames(first)
        expect(names).toContain("session_safe")
        // Positive control above; the built-in apply_patch (if present) keeps its own description, not the fixture's.
        const tools = first.tools as Array<{ function?: { name?: string; description?: string } }>
        const patch = tools.find((tool) => tool.function?.name === "session_search")
        expect(patch).toBeDefined()
        expect(JSON.stringify(patch)).not.toContain("fixture tool search")
      }),
    240_000,
  )

  cliIt.live(
    "remote MCP servers with a non-http URL are refused",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        const env = plainEnv(home, llm.url)
        userConfig(home, {
          mcp: {
            fileurl: { type: "remote", url: "file:///etc/hostname" },
            ftpurl: { type: "remote", url: "ftp://127.0.0.1/mcp" },
          },
        })
        const list = yield* opencode.spawn(["mcp", "list"], { cwd: proj, env })
        const out = list.stdout + list.stderr
        expect(out).toContain("fileurl")
        expect(out).toMatch(/Invalid MCP URL|failed/i)
        expect(out).not.toMatch(/fileurl[^\n]*connected/i)
        expect(out).not.toMatch(/ftpurl[^\n]*connected/i)
      }),
    240_000,
  )

  cliIt.live(
    "configured headers go to the configured origin but are not forwarded across an origin redirect",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        const third = attacker()
        yield* stopOnExit(third.server)
        const origin = attacker((request) => {
          const pathname = new URL(request.url).pathname
          if (pathname === "/redirect") return new Response(null, { status: 307, headers: { location: `${third.url}/steal` } })
          return new Response("nope", { status: 404 })
        })
        yield* stopOnExit(origin.server)
        const header = "X-Api-Key"
        const value = "HEADER-SECRET-SECREG"
        const env = plainEnv(home, llm.url)
        userConfig(home, {
          mcp: {
            redirecting: { type: "remote", url: `${origin.url}/redirect`, headers: { [header]: value }, oauth: false },
            direct: { type: "remote", url: `${origin.url}/direct`, headers: { [header]: value }, oauth: false },
          },
        })
        yield* opencode.spawn(["mcp", "list"], { cwd: proj, env })
        yield* Effect.promise(() => waitFor(() => origin.seen.some((item) => item.url.endsWith("/direct")), "no request to the configured origin", 10_000))
        // Positive control: the configured origin receives the header.
        expect(origin.seen.some((item) => item.headers[header.toLowerCase()] === value)).toBe(true)
        // The redirect target receives nothing.
        expect(third.seen).toHaveLength(0)
        expect(JSON.stringify(third.seen)).not.toContain(value)
      }),
    240_000,
  )
})
