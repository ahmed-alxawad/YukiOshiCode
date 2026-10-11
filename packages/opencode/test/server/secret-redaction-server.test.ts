import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { AbsolutePath } from "@yukioshi/core/schema"
import { ModelV2 } from "@yukioshi/core/model"
import { ProviderV2 } from "@yukioshi/core/provider"
import { SessionV1 } from "@yukioshi/core/v1/session"
import { Cause, Effect, Layer, Queue, Schema, Stream } from "effect"
import path from "path"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { failureEvent } from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect, testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const providerID = "secret-redaction-test"
const modelID = "secret-redaction-model"
const apiKey = "provider-api-key-C1-item-4-0123456789"
const secondApiKey = "provider-api-key-C1-item-4-ABCDEFGHIJ"
const token = "provider-token-C1-item-4-abcdefghij"
const ordinaryUserPrompt = "token=ordinary-user-prompt-12345678"
const placeholder = "[REDACTED:provider-key]"

const config = {
  formatter: false,
  lsp: false,
  provider: {
    [providerID]: {
      name: "Secret redaction test provider",
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:1/v1",
      options: {
        apiKey,
        apiKeys: [apiKey, secondApiKey],
        token,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Api-Key": apiKey,
          "X-Trace": "public-header",
        },
      },
      models: {
        [modelID]: {
          name: "Secret redaction test model",
        },
      },
    },
  },
}

const it = testEffect(Layer.mergeAll(LayerNode.compile(Session.node), httpApiLayer))
const sharedIt = testEffectShared(Layer.mergeAll(LayerNode.compile(EventV2Bridge.node), httpApiLayer))

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Any,
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

function optionsFromConfig(body: unknown) {
  const configBody = body as { provider: Record<string, { options: Record<string, unknown> }> }
  return configBody.provider[providerID]!.options
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("server secret redaction", () => {
  it.instance(
    "masks provider keys and tokens from config and provider option responses",
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const configResponse = yield* requestInDirectory("/config", directory)
      expect(configResponse.status).toBe(200)

      const configBody = yield* configResponse.json
      const configText = JSON.stringify(configBody)
      expect(configText).not.toContain(apiKey)
      expect(configText).not.toContain(secondApiKey)
      expect(configText).not.toContain(token)
      expect(optionsFromConfig(configBody)).toMatchObject({
        apiKey: placeholder,
        apiKeys: [placeholder, placeholder],
        token: placeholder,
        headers: {
          Authorization: placeholder,
          "X-Api-Key": placeholder,
          "X-Trace": "public-header",
        },
      })

      for (const endpoint of ["/config/providers", "/provider"]) {
        const response = yield* requestInDirectory(endpoint, directory)
        expect(response.status).toBe(200)
        const text = yield* response.text
        expect(text).toContain(providerID)
        expect(text).not.toContain(apiKey)
        expect(text).not.toContain(secondApiKey)
        expect(text).not.toContain(token)
      }
    }),
    { config },
  )

  it.instance(
    "keeps the real provider credential when a config update sends the response placeholder back",
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const getResponse = yield* requestInDirectory("/config", directory)
      expect(getResponse.status).toBe(200)
      const getBody = (yield* getResponse.json) as Record<string, unknown>

      const updateResponse = yield* requestInDirectory("/config", directory, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...getBody, username: "updated-after-redaction" }),
      })
      expect(updateResponse.status).toBe(200)
      const updateText = yield* updateResponse.text
      expect(updateText).not.toContain(apiKey)
      expect(updateText).not.toContain(secondApiKey)
      expect(updateText).not.toContain(token)

      const stored = (yield* Effect.promise(() => Bun.file(path.join(directory, "config.json")).json())) as {
        provider: Record<string, { options: Record<string, unknown> }>
      }
      expect(stored.provider[providerID]!.options).toMatchObject({
        apiKey,
        apiKeys: [apiKey, secondApiKey],
        token,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Api-Key": apiKey,
        },
      })
    }),
    { config },
  )

  it.instance(
    "masks configured provider credentials from session messages without changing ordinary user prompts",
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const model = {
        providerID: ProviderV2.ID.make(providerID),
        modelID: ModelV2.ID.make(modelID),
      }
      const userID = MessageID.ascending()
      const assistantID = MessageID.ascending()

      yield* sessions.updateMessage({
        id: userID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model,
        tools: {},
      } as SessionV1.User)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: userID,
        type: "text",
        text: ordinaryUserPrompt,
      } as SessionV1.TextPart)
      yield* sessions.updateMessage({
        id: assistantID,
        sessionID: session.id,
        role: "assistant",
        time: { created: Date.now() + 1 },
        parentID: userID,
        providerID: model.providerID,
        modelID: model.modelID,
        mode: "build",
        agent: "test",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as SessionV1.Assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: assistantID,
        type: "text",
        text: `Provider error echoed ${apiKey}`,
      } as SessionV1.TextPart)

      const response = yield* requestInDirectory(`/session/${session.id}/message`, directory)
      expect(response.status).toBe(200)
      const messages = (yield* response.json) as SessionV1.WithParts[]
      const text = JSON.stringify(messages)
      expect(text).not.toContain(apiKey)
      expect(text).toContain(placeholder)

      const user = messages.find((message) => message.info.id === userID)
      const userText = user?.parts.find((part): part is SessionV1.TextPart => part.type === "text")
      expect(userText?.text).toBe(ordinaryUserPrompt)
    }),
    { git: true, config },
  )

  sharedIt.instance(
    "masks provider credentials from session error events on the event stream",
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const response = yield* requestInDirectory(EventPaths.event, directory)
      expect(response.status).toBe(200)
      const reader = yield* Queue.unbounded<Uint8Array>()
      yield* response.stream.pipe(
        Stream.runForEach((value) => Queue.offer(reader, value)),
        Effect.forkScoped,
      )
      expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

      const events = yield* EventV2Bridge.Service
      yield* events.publish(
        Session.Event.Error,
        {
          sessionID: SessionID.make("ses_secret_redaction_event"),
          error: failureEvent(Cause.fail(new Error(`provider failure: ${apiKey}`))),
        },
        { location: { directory: AbsolutePath.make(directory) } },
      )

      const error = yield* readEvent(reader)
      expect(error.type).toBe(Session.Event.Error.type)
      const text = JSON.stringify(error)
      expect(text).not.toContain(apiKey)
      expect(text).toContain(placeholder)
    }),
    { config },
  )
})
