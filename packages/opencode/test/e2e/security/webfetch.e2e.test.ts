// Scenario 8: webfetch against hostile servers. The response is capped while it streams, a redirect to
// another origin asks again, and a redirect to a non-http URL is refused even when everything is allowed.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { requestText, requestToolResults } from "../helpers"
import { attacker, makeProject, plainEnv, stopOnExit, userConfig } from "./util"

const lastResult = (inputs: Record<string, unknown>[]) => requestToolResults(inputs.at(-1)!).at(-1) ?? ""

describe("security: webfetch", () => {
  cliIt.live(
    "an endless streaming response is cut off at the size limit; a small one is returned",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        userConfig(home, { webfetch: { allow_private: true } })
        const proj = makeProject(home)
        let sent = 0
        let cancelled = false
        const chunk = new Uint8Array(256 * 1024).fill(97)
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            if (new URL(request.url).pathname === "/small") return new Response("SMALL-PAGE-SECREG", { headers: { "content-type": "text/plain" } })
            return new Response(
              new ReadableStream({
                async pull(controller) {
                  controller.enqueue(chunk)
                  sent += chunk.byteLength
                  await Bun.sleep(1)
                  if (sent > 200 * 1024 * 1024) controller.close()
                },
                cancel() {
                  cancelled = true
                },
              }),
              { headers: { "content-type": "text/plain" } },
            )
          },
        })
        yield* stopOnExit(server)
        const base = server.url.toString().replace(/\/$/, "")
        const env = plainEnv(home, llm.url)

        yield* llm.push(reply().tool("webfetch", { url: `${base}/endless`, format: "text" }), reply().text("done").stop())
        const result = yield* opencode.run("fetch the endless page", { cwd: proj, env, extraArgs: ["--dangerously-skip-permissions"], timeoutMs: 60_000 })
        expect(result.exitCode).toBe(0)
        expect(lastResult(yield* llm.inputs)).toContain("Response too large")
        yield* Effect.sleep("300 millis")
        expect(sent).toBeLessThan(40 * 1024 * 1024)
        expect(cancelled).toBe(true)

        yield* llm.reset
        yield* llm.push(reply().tool("webfetch", { url: `${base}/small`, format: "text" }), reply().text("done").stop())
        const small = yield* opencode.run("fetch the small page", { cwd: proj, env, extraArgs: ["--dangerously-skip-permissions"] })
        expect(small.exitCode).toBe(0)
        expect(lastResult(yield* llm.inputs)).toContain("SMALL-PAGE-SECREG")
      }),
    240_000,
  )

  cliIt.live(
    "a redirect to another origin asks again; a redirect to file:// is refused even when everything is allowed",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        userConfig(home, { webfetch: { allow_private: true } })
        const proj = makeProject(home)
        const target = attacker(() => new Response("REDIRECT-TARGET-SECREG", { headers: { "content-type": "text/plain" } }))
        yield* stopOnExit(target.server)
        const origin = Bun.serve({
          port: 0,
          fetch: (request) => {
            const pathname = new URL(request.url).pathname
            if (pathname === "/cross") return new Response(null, { status: 302, headers: { location: `${target.url}/landing` } })
            if (pathname === "/file") return new Response(null, { status: 302, headers: { location: "file:///etc/hostname" } })
            return new Response("ORIGIN-DIRECT", { headers: { "content-type": "text/plain" } })
          },
        })
        yield* stopOnExit(origin)
        const base = origin.url.toString().replace(/\/$/, "")

        // With webfetch on "ask" and a reviewer answering each ask, the redirect produces a second ask.
        const askEnv = plainEnv(home, llm.url, { permission: { webfetch: "ask" } })
        const fromReviewer = (hit: { body: Record<string, unknown> }) => requestText(hit.body).includes("<action>")
        yield* llm.pushMatch(
          (hit) => !fromReviewer(hit),
          reply().tool("webfetch", { url: `${base}/cross`, format: "text" }),
          reply().text("done").stop(),
        )
        yield* llm.pushMatch(
          fromReviewer,
          reply().text("ALLOW: the first URL was requested").stop(),
          reply().text("DENY: the redirect target was not requested").stop(),
        )
        const asked = yield* opencode.run("fetch with redirect", { cwd: proj, env: askEnv, extraArgs: ["--mode", "review"] })
        expect(asked.exitCode).toBe(0)
        const reviews = (yield* llm.inputs).filter((input) => requestText(input).includes("<action>"))
        expect(reviews).toHaveLength(2)
        expect(requestText(reviews[0]!)).toContain(`${base}/cross`)
        expect(requestText(reviews[1]!)).toContain(`${target.url}/landing`)
        expect(target.seen).toHaveLength(0)

        // Positive control: when the second ask is allowed too, the redirect is followed.
        yield* llm.reset
        yield* llm.pushMatch(
          (hit) => !fromReviewer(hit),
          reply().tool("webfetch", { url: `${base}/cross`, format: "text" }),
          reply().text("done").stop(),
        )
        yield* llm.pushMatch(fromReviewer, reply().text("ALLOW: ok").stop(), reply().text("ALLOW: ok").stop())
        const allowed = yield* opencode.run("fetch with redirect", { cwd: proj, env: askEnv, extraArgs: ["--mode", "review"] })
        expect(allowed.exitCode).toBe(0)
        expect(target.seen.length).toBeGreaterThan(0)
        expect(lastResult((yield* llm.inputs).filter((input) => !requestText(input).includes("<action>")))).toContain("REDIRECT-TARGET-SECREG")

        // A redirect to a file: URL is refused even when every permission is granted.
        yield* llm.reset
        yield* llm.push(reply().tool("webfetch", { url: `${base}/file`, format: "text" }), reply().text("done").stop())
        const file = yield* opencode.run("fetch file redirect", { cwd: proj, env: plainEnv(home, llm.url), extraArgs: ["--dangerously-skip-permissions"] })
        expect(file.exitCode).toBe(0)
        expect(lastResult(yield* llm.inputs)).toContain("non-http URL was refused")
      }),
    240_000,
  )
})
