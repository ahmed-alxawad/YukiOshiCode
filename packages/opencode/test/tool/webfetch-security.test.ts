import { describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { httpClient } from "@yukioshi/core/effect/app-node-platform"
import { Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

function makeCtx() {
  const asked: string[][] = []
  const ctx = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_message"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req: { patterns: string[] }) => Effect.sync(() => void asked.push(req.patterns)),
  } as unknown as Tool.Context
  return { asked, ctx }
}

const serve = (fetch: (req: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchSecurityTest.exec")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
  ctx: Tool.Context,
) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch security", () => {
  it.instance("stops reading an endless response at the size limit", () =>
    Effect.gen(function* () {
      let sent = 0
      const chunk = new Uint8Array(64 * 1024).fill(65)
      const server = yield* serve(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                sent += chunk.byteLength
                controller.enqueue(chunk)
              },
            }),
            { headers: { "content-type": "text/plain" } },
          ),
      )
      const { ctx } = makeCtx()
      const exit = yield* exec({ url: server.url.toString(), format: "text", timeout: 20 }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("too large")
      expect(sent).toBeLessThan(32 * 1024 * 1024)
    }),
  )

  it.instance("asks again when a redirect leaves the origin that was approved", () =>
    Effect.gen(function* () {
      const internal = yield* serve(() => new Response("internal secret", { headers: { "content-type": "text/plain" } }))
      const internalUrl = `http://localhost:${internal.port}/meta`
      const front = yield* serve(() => new Response(null, { status: 302, headers: { location: internalUrl } }))
      const { asked, ctx } = makeCtx()

      const result = yield* exec({ url: front.url.toString(), format: "text" }, ctx)

      expect(result.output).toBe("internal secret")
      expect(asked.length).toBe(2)
      expect(asked[1]).toEqual([internalUrl])
    }),
  )

  it.instance("does not ask again for a redirect inside the same origin", () =>
    Effect.gen(function* () {
      const server = yield* serve((req) =>
        new URL(req.url).pathname === "/final"
          ? new Response("ok", { headers: { "content-type": "text/plain" } })
          : new Response(null, { status: 301, headers: { location: "/final" } }),
      )
      const { asked, ctx } = makeCtx()

      const result = yield* exec({ url: new URL("/start", server.url).toString(), format: "text" }, ctx)

      expect(result.output).toBe("ok")
      expect(asked.length).toBe(1)
    }),
  )

  it.instance("refuses a redirect to a file URL", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }))
      const { ctx } = makeCtx()
      const exit = yield* exec({ url: server.url.toString(), format: "text" }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).not.toContain("root:")
    }),
  )

  it.instance("gives up on a redirect loop", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response(null, { status: 302, headers: { location: "/again" } }))
      const { ctx } = makeCtx()
      const exit = yield* exec({ url: server.url.toString(), format: "text" }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("Too many redirects")
    }),
  )
})
