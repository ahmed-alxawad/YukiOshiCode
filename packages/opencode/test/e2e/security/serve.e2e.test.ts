// Scenario 7: `yukioshi serve` as a target. A foreign web page (CSRF), a DNS-rebinding host name, a
// wrong password and a hostile trigger request must all be refused, and a trigger run is forced into
// review or plan mode that the request cannot change.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { requestText } from "../helpers"
import { exists, plainEnv, userConfig } from "./util"

// fetch() will not let a script choose the Host header, so speak HTTP over a socket.
function rawGet(port: number, host: string, target = "/global/health") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    let data = ""
    socket.on("data", (chunk) => (data += chunk.toString()))
    socket.on("error", reject)
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.\d (\d+)/.exec(data)?.[1] ?? 0)
      resolve({ status, body: data.split("\r\n\r\n").slice(1).join("\r\n\r\n") })
    })
  })
}

const basic = (password: string, user = "opencode") => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`

describe("security: yukioshi serve", () => {
  cliIt.live(
    "refuses a foreign Origin on mutating requests and a foreign Host header, and accepts the legitimate ones",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({ env: plainEnv(home, llm.url) })

        // CSRF: a body-less POST from another origin never reaches the handler.
        const evil = yield* Effect.promise(() =>
          fetch(`${server.url}/instance/dispose`, { method: "POST", headers: { origin: "https://evil.example" } }),
        )
        expect(evil.status).toBe(403)
        expect(yield* Effect.promise(() => evil.text())).toContain("origin not allowed")
        const nullOrigin = yield* Effect.promise(() =>
          fetch(`${server.url}/instance/dispose`, { method: "POST", headers: { origin: "null" } }),
        )
        expect(nullOrigin.status).toBe(403)
        // Positive control: no Origin (CLI, SDK) and the server's own origin are accepted.
        const own = yield* Effect.promise(() =>
          fetch(`${server.url}/instance/dispose`, { method: "POST", headers: { origin: server.url } }),
        )
        expect(own.status).toBe(200)
        const none = yield* Effect.promise(() => fetch(`${server.url}/instance/dispose`, { method: "POST" }))
        expect(none.status).toBe(200)

        // DNS rebinding: an unexpected Host on an unauthenticated loopback server is refused.
        const rebound = yield* Effect.promise(() => rawGet(server.port, "rebind.attacker.example"))
        expect(rebound.status).toBe(403)
        expect(rebound.body).toContain("unexpected Host header")
        const loopback = yield* Effect.promise(() => rawGet(server.port, `localhost:${server.port}`))
        expect(loopback.status).toBe(200)
        const literal = yield* Effect.promise(() => rawGet(server.port, `127.0.0.1:${server.port}`))
        expect(literal.status).toBe(200)
      }),
    90_000,
  )

  cliIt.live(
    "a wrong or missing password is refused and the right one is accepted",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const password = "correct-horse-battery-staple-secreg"
        const server = yield* opencode.serve({
          env: { ...plainEnv(home, llm.url), YUKIOSHI_SERVER_PASSWORD: password },
        })
        const get = (headers: Record<string, string>) =>
          Effect.promise(() => fetch(`${server.url}/global/health`, { headers }))
        expect((yield* get({})).status).toBe(401)
        expect((yield* get({ authorization: basic("wrong-password") })).status).toBe(401)
        expect((yield* get({ authorization: basic(password.slice(0, -1)) })).status).toBe(401)
        expect((yield* get({ authorization: `Bearer ${password}` })).status).toBe(401)
        const post = yield* Effect.promise(() => fetch(`${server.url}/instance/dispose`, { method: "POST" }))
        expect(post.status).toBe(401)
        expect((yield* get({ authorization: basic(password) })).status).toBe(200)
      }),
    90_000,
  )

  cliIt.live(
    "the trigger endpoint answers 401, 403, 413 and 415 to hostile requests and rejects fields that change the mode",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const token = "t".repeat(40)
        const allowed = path.join(home, "allowed")
        fs.mkdirSync(allowed)
        userConfig(home, { triggers: { enabled: true, token_env: "SECREG_TRIGGER_TOKEN", directories: [allowed] } })
        const server = yield* opencode.serve({
          env: { ...plainEnv(home, llm.url), SECREG_TRIGGER_TOKEN: token },
        })
        const post = (init: { headers?: Record<string, string>; body?: string }) =>
          Effect.promise(() => fetch(`${server.url}/trigger`, { method: "POST", ...init }))
        const json = { "content-type": "application/json" }
        const auth = { authorization: `Bearer ${token}` }
        const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ prompt: "p", directory: allowed, ...extra })

        expect((yield* post({ headers: json, body: body() })).status).toBe(401)
        expect((yield* post({ headers: { ...json, authorization: "Bearer nope" }, body: body() })).status).toBe(401)
        expect((yield* post({ headers: { ...json, authorization: basic(token) }, body: body() })).status).toBe(401)
        expect((yield* post({ headers: { ...auth, "content-type": "text/plain" }, body: body() })).status).toBe(415)
        expect(
          (yield* post({ headers: { ...auth, ...json }, body: JSON.stringify({ prompt: "p", directory: home }) })).status,
        ).toBe(403)
        expect(
          (yield* post({ headers: { ...auth, ...json }, body: JSON.stringify({ prompt: "p", directory: path.join(allowed, "..") }) })).status,
        ).toBe(403)
        expect((yield* post({ headers: { ...auth, ...json }, body: body({ prompt: "x".repeat(70_000) }) })).status).toBe(413)
        // The body cannot choose the permission mode or turn permissions off.
        for (const extra of [{ mode: "auto" }, { permission: "allow" }, { dangerouslySkipPermissions: true }]) {
          expect((yield* post({ headers: { ...auth, ...json }, body: body(extra) })).status).toBe(400)
        }
        // A foreign page cannot trigger a run either.
        const cross = yield* post({ headers: { ...auth, ...json, origin: "https://evil.example" }, body: body() })
        expect(cross.status).toBe(403)
        // Nothing above started a model request.
        expect(yield* llm.calls).toBe(0)
      }),
    90_000,
  )

  for (const mode of ["plan", "review"] as const) {
    cliIt.live(
      `a trigger run is forced into ${mode} mode: the model cannot write files the rules would allow`,
      ({ home, llm, opencode }) =>
        Effect.gen(function* () {
          const token = "m".repeat(40)
          const dir = path.join(home, "work")
          fs.mkdirSync(dir)
          userConfig(home, { triggers: { enabled: true, token_env: "SECREG_TRIGGER_TOKEN", directories: [dir], mode } })
          const target = path.join(dir, "from-trigger")
          const fromReviewer = (hit: { body: Record<string, unknown> }) => requestText(hit.body).includes("<action>")
          yield* llm.pushMatch(
            (hit) => !fromReviewer(hit),
            reply().tool("bash", { command: `touch "${target}"`, description: "touch" }),
            reply().text("finished").stop(),
          )
          // In review mode the reviewer refuses; in plan mode it is never asked.
          yield* llm.pushMatch(fromReviewer, reply().text("DENY: not requested").stop())
          const server = yield* opencode.serve({
            env: { ...plainEnv(home, llm.url, { model: "test/test-model" }), SECREG_TRIGGER_TOKEN: token },
          })
          const res = yield* Effect.promise(() =>
            fetch(`${server.url}/trigger`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ prompt: "touch the file", directory: dir }),
            }),
          )
          expect(res.status).toBe(202)
          // Wait for the run to finish its two model turns.
          const deadline = Date.now() + 30_000
          while (Date.now() < deadline && (yield* llm.calls) < 2) yield* Effect.sleep("100 millis")
          yield* Effect.sleep("1 second")
          expect(exists(target)).toBe(false)
        }),
      90_000,
    )
  }
})
