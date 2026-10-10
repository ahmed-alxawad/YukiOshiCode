import { afterEach, describe, expect, test } from "bun:test"
import { Context, Config as EffectConfig, Effect, Layer, Queue, Schema } from "effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import path from "path"
import { pathToFileURL } from "url"
import { mkdir } from "fs/promises"
import { Location } from "@yukioshi/core/location"
import { Pty } from "@yukioshi/core/pty"
import { PtyTicket } from "@yukioshi/core/pty/ticket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir, tmpdirScoped, trustProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testPty = process.platform === "win32" ? test.skip : test

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-yukioshi-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const servedRoutes: Layer.Layer<never, EffectConfig.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const effectIt = testEffect(
  Layer.mergeAll(
    testStateLayer,
    Socket.layerWebSocketConstructorGlobal,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-yukioshi-directory", dir)

const serverUrl = () => HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 pty HttpApi", () => {
  testPty(
    "serves location-wrapped PTY routes and retains exited sessions",
    async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

      const empty = await request("/api/pty", tmp.path)
      expect(empty.status).toBe(200)
      expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Pty.Info)))(await empty.json()).data).toEqual([])

      const created = await request("/api/pty", tmp.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "exit 4"], title: "v2" }),
      })
      expect(created.status).toBe(200)
      const body = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json())
      expect(String(body.location.directory)).toBe(tmp.path)
      expect(body.data.title).toBe("v2")

      // The canonical surface keeps exited sessions observable with their exit code.
      // Bounded retry on the observable state: the exit event is delivered asynchronously by the
      // native PTY, so poll the session info until it reports the exit rather than assuming timing.
      const deadline = Date.now() + 30_000
      let info: { status: string; exitCode?: number } | undefined
      for (let attempt = 0; ; attempt++) {
        const found = await request(`/api/pty/${body.data.id}`, tmp.path)
        expect(found.status).toBe(200)
        info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await found.json()).data
        if (info.status === "exited" || Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 250)))
      }
      expect(info).toMatchObject({ status: "exited", exitCode: 4 })

      const removed = await request(`/api/pty/${body.data.id}`, tmp.path, { method: "DELETE" })
      expect(removed.status).toBe(204)

      const missing = await request(`/api/pty/${body.data.id}`, tmp.path)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ _tag: "PtyNotFoundError", ptyID: body.data.id })
    },
    45_000,
  )

  testPty(
    "rejects connect tokens without the CSRF header and connects with a valid ticket",
    async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
      const created = await request("/api/pty", tmp.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/bin/cat" }),
      })
      expect(created.status).toBe(200)
      const info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json()).data

      try {
        const forbidden = await request(`/api/pty/${info.id}/connect-token`, tmp.path, { method: "POST" })
        expect(forbidden.status).toBe(403)
        expect(await forbidden.json()).toMatchObject({ _tag: "ForbiddenError" })

        const token = await request(`/api/pty/${info.id}/connect-token`, tmp.path, {
          method: "POST",
          headers: { "x-yukioshi-ticket": "1" },
        })
        expect(token.status).toBe(200)
        const ticket = Schema.decodeUnknownSync(Location.response(PtyTicket.ConnectToken))(await token.json()).data
          .ticket
        expect(ticket).toBeTruthy()

        const invalid = await request(`/api/pty/${info.id}/connect?ticket=not-a-ticket`, tmp.path)
        expect(invalid.status).toBe(403)
      } finally {
        await request(`/api/pty/${info.id}`, tmp.path, { method: "DELETE" })
      }
    },
    30_000,
  )
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "serves PTY websocket output and input through the canonical route",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
        const created = yield* HttpClientRequest.post("/api/pty").pipe(
          directoryHeader(dir),
          HttpClientRequest.bodyJson({ command: "/bin/cat", title: "v2-websocket" }),
          Effect.flatMap(HttpClient.execute),
        )
        expect(created.status).toBe(200)
        const body = yield* Schema.decodeUnknownEffect(Location.response(Pty.Info))(yield* created.json)
        const info = body.data
        yield* Effect.addFinalizer(() =>
          HttpClientRequest.delete(`/api/pty/${info.id}`).pipe(directoryHeader(dir), HttpClient.execute, Effect.ignore),
        )

        const socket = yield* Socket.makeWebSocket(
          `${(yield* serverUrl()).replace(/^http/, "ws")}/api/pty/${info.id}/connect?cursor=-1&location[directory]=${encodeURIComponent(dir)}`,
          { closeCodeIsError: () => false },
        )
        const messages = yield* Queue.unbounded<string>()
        yield* socket
          .runRaw((message) =>
            Queue.offer(messages, typeof message === "string" ? message : new TextDecoder().decode(message)),
          )
          .pipe(Effect.catch(() => Effect.void))
          .pipe(Effect.forkScoped)
        const write = yield* socket.writer

        // Accumulate frames until the expected marker shows up, bounded by a timeout per frame.
        const takeUntil = (expected: string, seen = ""): Effect.Effect<string, unknown> =>
          Effect.gen(function* () {
            const next = seen + (yield* Queue.take(messages).pipe(Effect.timeout("30 seconds")))
            if (next.includes(expected)) return next
            return yield* takeUntil(expected, next)
          })

        // The server sends a 0x00 control frame once replay is applied and live delivery is active.
        // Input sent earlier could be dropped because the server is not reading the socket yet.
        yield* takeUntil("\u0000")

        // Even after the meta frame the server-side reader may attach a tick later, so resend the
        // input a bounded number of times until the PTY echoes the marker back.
        const echoed = (attempt: number): Effect.Effect<string, unknown> =>
          Effect.gen(function* () {
            yield* write("ping-v2\n")
            const result = yield* takeUntil("ping-v2").pipe(Effect.timeoutOption("2 seconds"))
            if (result._tag === "Some") return result.value
            if (attempt >= 10) return yield* Effect.fail(new Error("PTY never echoed ping-v2"))
            return yield* echoed(attempt + 1)
          })
        expect(yield* echoed(0)).toContain("ping-v2")
        yield* write(new Socket.CloseEvent(1000, "done")).pipe(Effect.catch(() => Effect.void))

        const removed = yield* HttpClientRequest.delete(`/api/pty/${info.id}`).pipe(
          directoryHeader(dir),
          HttpClient.execute,
        )
        expect(removed.status).toBe(204)
      }),
    30_000,
  )
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "applies plugin shell environment before forced PTY values",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, trusted: true, config: { formatter: false, lsp: false } })
        const plugin = path.join(dir, "plugin.ts")
        const cwd = path.join(dir, "child")
        yield* Effect.promise(() => mkdir(cwd))
        yield* Effect.promise(() =>
          Bun.write(
            plugin,
            [
              "export default async () => ({",
              '  "shell.env": (input, output) => {',
              '    output.env.SHARED = "plugin"',
              '    output.env.PLUGIN = "plugin"',
              '    output.env.TERM = "plugin"',
              "    output.env.HOOK_CWD = input.cwd",
              "  },",
              "})",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({ plugin: [pathToFileURL(plugin).href], formatter: false, lsp: false }),
          ),
        )
        yield* trustProject(dir)

        const created = yield* HttpClientRequest.post("/api/pty").pipe(
          directoryHeader(dir),
          HttpClientRequest.bodyJson({
            command: "/bin/sh",
            args: ["-c", 'printf "%s|%s|%s|%s|%s\\n" "$CALLER" "$SHARED" "$PLUGIN" "$TERM" "$HOOK_CWD"; exec cat'],
            cwd,
            env: { CALLER: "caller", SHARED: "caller", TERM: "caller" },
          }),
          Effect.flatMap(HttpClient.execute),
        )
        expect(created.status).toBe(200)
        const info = (yield* Schema.decodeUnknownEffect(Location.response(Pty.Info))(yield* created.json)).data
        yield* Effect.addFinalizer(() =>
          HttpClientRequest.delete(`/api/pty/${info.id}`).pipe(directoryHeader(dir), HttpClient.execute, Effect.ignore),
        )

        const socket = yield* Socket.makeWebSocket(
          `${(yield* serverUrl()).replace(/^http/, "ws")}/api/pty/${info.id}/connect?cursor=0&location[directory]=${encodeURIComponent(dir)}`,
          { closeCodeIsError: () => false },
        )
        const messages = yield* Queue.unbounded<string>()
        yield* socket
          .runRaw((message) =>
            Queue.offer(messages, typeof message === "string" ? message : new TextDecoder().decode(message)),
          )
          .pipe(
            Effect.catch(() => Effect.void),
            Effect.forkScoped,
          )
        const write = yield* socket.writer

        const loop = (expected: string, seen = ""): Effect.Effect<string, unknown> =>
          Effect.gen(function* () {
            const chunk = yield* Queue.take(messages)
            const next = seen + chunk
            if (next.includes(expected)) return next
            return yield* loop(expected, next)
          })
        const takeUntil = (expected: string) =>
          loop(expected).pipe(
            Effect.timeoutOrElse({
              duration: "40 seconds",
              orElse: () => Effect.fail(new Error(`Timed out waiting for ${expected}`)),
            }),
          )

        expect(yield* takeUntil(`caller|plugin|plugin|xterm-256color|${cwd}`)).toContain(
          `caller|plugin|plugin|xterm-256color|${cwd}`,
        )
        yield* write(new Socket.CloseEvent(1000, "done")).pipe(Effect.catch(() => Effect.void))
        yield* HttpClientRequest.delete(`/api/pty/${info.id}`).pipe(directoryHeader(dir), HttpClient.execute)
      }),
    75_000,
  )
})
