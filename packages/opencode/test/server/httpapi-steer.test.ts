// Steering over the HTTP API: a message posted with `prompt_async` while a turn runs a tool reaches the model in the
// next request of that same turn, after the tool result. This is what `yukioshi run --attach`, ACP clients and the
// terminal UI rely on when they send a message while the agent works.
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs"
import path from "path"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { FSUtil } from "@yukioshi/core/fs-util"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Database } from "@yukioshi/core/database/database"
import { createOpencodeClient } from "@yukioshi/sdk/v2"
import { HttpServer } from "effect/unstable/http"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session as SessionNs } from "@/session/session"
import { TestLLMServer } from "../lib/llm-server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer } from "./httpapi-layer"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node, SessionNs.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))
const unix = process.platform !== "win32" ? it.live : it.live.skip

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const sdkFor = (directory: string) =>
  HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      const baseUrl = HttpServer.formatAddress(server.address)
      const fetch = Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          const url = new URL(source.url)
          return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
        },
        { preconnect: globalThis.fetch.preconnect },
      ) satisfies typeof globalThis.fetch
      return createOpencodeClient({ baseUrl: "http://localhost", directory, fetch })
    }),
  )

const model = { providerID: "test", modelID: "test-model" }

function transcript(input: Record<string, unknown>) {
  const messages = input.messages
  if (!Array.isArray(messages)) throw new Error("expected messages in the model request")
  return messages.flatMap((msg: any): string[] => {
    if (msg.role === "system") return []
    if (msg.role === "tool")
      return [`tool: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`]
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)
      return [`assistant: tool_call ${msg.tool_calls.map((call: any) => call.function?.name).join(",")}`]
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((part: any) => part.text ?? "").join("")
          : ""
    return [`${msg.role}: ${content}`]
  })
}

describe("steering over the HTTP API", () => {
  unix(
    "prompt_async while a tool runs reaches the next model request of the same turn, after the tool result",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, trusted: true, config: testProviderConfig(llm.url) })
        const sdk = yield* sdkFor(directory)
        const gate = path.join(directory, "go")
        yield* llm.tool("bash", {
          command: `while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.05; done; printf HTTP-TOOL-RESULT`,
          timeout: 20_000,
          workdir: directory,
          description: "wait for gate",
        })
        yield* llm.text("done")

        const created = yield* Effect.promise(() =>
          sdk.session.create({ title: "steer", permission: [{ permission: "*", pattern: "*", action: "allow" }] }),
        )
        const sessionID = created.data!.id
        const first = yield* Effect.promise(() =>
          sdk.session.promptAsync({ sessionID, agent: "build", model, parts: [{ type: "text", text: "first task" }] }),
        )
        expect(first.response.status).toBe(204)

        yield* pollWithTimeout(
          Effect.promise(async () => {
            const msgs = (await sdk.session.messages({ sessionID })).data ?? []
            const running = msgs.some(
              (msg) =>
                msg.info.role === "assistant" &&
                msg.parts.some((part) => part.type === "tool" && part.state.status === "running"),
            )
            return running ? (true as const) : undefined
          }),
          "timed out waiting for the slow tool to start",
          "10 seconds",
        )

        const steer = yield* Effect.promise(() =>
          sdk.session.promptAsync({
            sessionID,
            agent: "build",
            model,
            parts: [{ type: "text", text: "steer via http" }],
          }),
        )
        expect(steer.response.status).toBe(204)
        yield* pollWithTimeout(
          Effect.promise(async () => {
            const msgs = (await sdk.session.messages({ sessionID })).data ?? []
            const saved = msgs.some(
              (msg) =>
                msg.info.role === "user" &&
                msg.parts.some((part) => part.type === "text" && part.text === "steer via http"),
            )
            return saved ? (true as const) : undefined
          }),
          "timed out waiting for the steering message to be saved",
          "10 seconds",
        )
        fs.writeFileSync(gate, "")

        yield* pollWithTimeout(
          Effect.promise(async () => {
            const status = (await sdk.session.status()).data ?? {}
            const busy = status[sessionID]?.type === "busy"
            return !busy && (await Effect.runPromise(llm.calls)) >= 2 ? (true as const) : undefined
          }),
          "timed out waiting for the turn to finish",
          "15 seconds",
        )

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        const lines = transcript(inputs[1]!)
        const toolResult = lines.findIndex((line) => line.startsWith("tool:") && line.includes("HTTP-TOOL-RESULT"))
        const steered = lines.findIndex((line) => line === "user: steer via http")
        expect(toolResult).toBeGreaterThan(-1)
        expect(steered).toBeGreaterThan(toolResult)

        const msgs = (yield* Effect.promise(() => sdk.session.messages({ sessionID }))).data ?? []
        const users = msgs.filter((msg) => msg.info.role === "user")
        const last = msgs.findLast((msg) => msg.info.role === "assistant")
        if (last?.info.role !== "assistant") throw new Error("expected a reply")
        expect(last.info.parentID).toBe(String(users.at(-1)?.info.id))
        expect(last?.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }).pipe(Effect.provide(TestLLMServer.layer)),
    30_000,
  )

  it.live("GET /config reports the steer setting, so split-footer clients can read it", () =>
    Effect.gen(function* () {
      const read = (directory: string) =>
        Effect.gen(function* () {
          const sdk = yield* sdkFor(directory)
          const config = (yield* Effect.promise(() => sdk.config.get())).data
          return config && "steer" in config ? config.steer : undefined
        })
      expect(yield* read(yield* tmpdirScoped({ trusted: true, config: { steer: true } }))).toBe(true)
      expect(yield* read(yield* tmpdirScoped({ trusted: true }))).toBeUndefined()
    }),
  )
})
