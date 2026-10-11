import { describe, expect, test } from "bun:test"
import { ConfigWebFetchV1 } from "@yukioshi/core/v1/config/webfetch"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { httpClient } from "@yukioshi/core/effect/app-node-platform"
import { Effect, Exit, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import * as PrivateAddress from "../../src/tool/webfetch-private"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

type Asked = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

function makeCtx(options: { unattended?: boolean } = {}) {
  const asked: Asked[] = []
  const ctx = {
    sessionID: SessionID.make("ses_webfetch_private"),
    messageID: MessageID.make("msg_webfetch_private"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    extra: options.unattended ? { unattended: true } : undefined,
    messages: [],
    metadata: () => Effect.void,
    ask: (request: Asked) => Effect.sync(() => void asked.push(request)),
  } as unknown as Tool.Context
  return { asked, ctx }
}

const serve = (fetch: (request: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchPrivateAddressTest.exec")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
  ctx: Tool.Context,
) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch private addresses", () => {
  test("defines the global allow_private option", () => {
    const decode = Schema.decodeUnknownSync(ConfigWebFetchV1.Info)
    expect(decode({ allow_private: true })).toEqual({ allow_private: true })
  })

  test("recognizes local numeric address spellings", async () => {
    const variants = [
      ["http://127.0.0.1/", "loopback"],
      ["http://2130706433/", "loopback"],
      ["http://0x7f000001/", "loopback"],
      ["http://0177.0.0.1/", "loopback"],
      ["http://10.0.0.1/", "private IPv4"],
      ["http://172.16.0.1/", "private IPv4"],
      ["http://192.168.0.1/", "private IPv4"],
      ["http://169.254.1.1/", "link-local"],
      ["http://0/", "unspecified IPv4"],
      ["http://[::1]/", "loopback"],
      ["http://[fe80::1]/", "link-local"],
      ["http://[fc00::1]/", "private IPv6"],
      ["http://[::ffff:7f00:1]/", "IPv4-mapped IPv6"],
      ["http://[::]/", "unspecified IPv6"],
    ] as const

    for (const [value, reason] of variants) {
      let resolved = false
      const target = await PrivateAddress.inspect(new URL(value), async () => {
        resolved = true
        return []
      })
      expect(resolved).toBe(false)
      expect(target.risks).toHaveLength(1)
      expect(target.risks[0]?.reason).toContain(reason)
    }
  })

  test("keeps public numeric targets outside the private-address warning path", async () => {
    const target = await PrivateAddress.inspect(new URL("http://8.8.8.8/"))
    expect(target.risks).toEqual([])
  })

  test("flags a private DNS answer, forces a warning, and pins it while connecting", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pinned") })
    try {
      let resolveCalls = 0
      const target = await PrivateAddress.inspect(new URL(`http://rebind.test:${server.port}/`), async () => {
        resolveCalls++
        return [{ address: "127.0.0.1", family: 4 }]
      })

      const response = await PrivateAddress.pinnedFetch(target)(target.url)

      expect(await response.text()).toBe("pinned")
      expect(resolveCalls).toBe(1)
      expect(target.risks[0]?.reason).toContain("loopback")
      expect(PrivateAddress.permissionMetadata(target, true)).toMatchObject({
        force_prompt: true,
        refuse_unattended: true,
        allow_private: true,
        addresses: [{ address: "127.0.0.1", reason: expect.stringContaining("loopback") }],
      })
    } finally {
      server.stop(true)
    }
  })

  it.instance("marks a local server with a mandatory private-address warning", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response("local", { headers: { "content-type": "text/plain" } }))
      const { asked, ctx } = makeCtx()

      const result = yield* exec({ url: server.url.toString(), format: "text" }, ctx)

      expect(result.output).toBe("local")
      const warning = asked.find((request) => request.metadata.private_address !== undefined)
      expect(warning).toMatchObject({
        permission: "webfetch",
        patterns: [server.url.toString()],
        always: [],
        metadata: {
          private_address: {
            force_prompt: true,
            refuse_unattended: true,
            allow_private: false,
            warning: expect.stringContaining("private or local network address"),
            addresses: [{ address: "127.0.0.1", reason: expect.stringContaining("loopback") }],
          },
        },
      })
      expect(asked).toHaveLength(1)
    }),
  )

  it.instance("warns for a redirect target that is private", () =>
    Effect.gen(function* () {
      const internal = yield* serve(() => new Response("internal", { headers: { "content-type": "text/plain" } }))
      const target = new URL("/metadata", internal.url).toString()
      const front = yield* serve(() => new Response(null, { status: 302, headers: { location: target } }))
      const { asked, ctx } = makeCtx()

      const result = yield* exec({ url: front.url.toString(), format: "text" }, ctx)

      expect(result.output).toBe("internal")
      expect(
        asked.some(
          (request) =>
            request.patterns[0] === target &&
            request.metadata.redirectedFrom === front.url.toString() &&
            request.metadata.private_address !== undefined,
        ),
      ).toBe(true)
    }),
  )

  it.instance("refuses a private target in an unattended context before connecting", () =>
    Effect.gen(function* () {
      let requests = 0
      const server = yield* serve(() => {
        requests++
        return new Response("should not be reached")
      })
      const { asked, ctx } = makeCtx({ unattended: true })

      const exit = yield* exec({ url: server.url.toString(), format: "text" }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("unattended")
      expect(requests).toBe(0)
      expect(asked).toHaveLength(0)
    }),
  )
})
