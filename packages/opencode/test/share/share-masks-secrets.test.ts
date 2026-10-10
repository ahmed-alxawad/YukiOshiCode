import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { httpClient } from "@yukioshi/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { SessionProjector } from "@yukioshi/core/session/projector"
import { Database } from "@yukioshi/core/database/database"
import { SessionShareTable } from "@yukioshi/core/share/sql"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { AccountRepo } from "../../src/account/repo"
import { Session } from "@/session/session"
import { ShareNext } from "@/share/share-next"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node])))

const openai = "sk-test-0123456789abcdefABCDEF0123456789"
const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

function layer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(
    LayerNode.group([
      ShareNext.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      AccountRepo.node,
      Database.node,
    ]),
    [replacement],
  )
}

beforeEach(async () => {
  await resetDatabase()
})

describe("session share", () => {
  it.live("secrets in a diff never reach the share server", () =>
    provideTmpdirInstance(
      () => {
        const seen: string[] = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array")
            seen.push(new TextDecoder().decode(req.body.body))
          return Effect.succeed(
            HttpClientResponse.fromWeb(req, new Response("{}", { headers: { "content-type": "application/json" } })),
          )
        })
        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const info = yield* (yield* Session.Service).create({ title: "share test" })
          yield* (yield* ShareNext.Service).init()
          yield* Effect.sleep(50)
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_abc",
              url: "https://legacy-share.example.com/share/abc",
              secret: "sec_123",
            })
            .run()
            .pipe(Effect.orDie)
          yield* events.publish(Session.Event.Diff, {
            sessionID: info.id,
            diff: [
              {
                file: ".env",
                patch: `--- .env\n+++ .env\n@@ -0,0 +1,2 @@\n+OPENAI_KEY=${openai}\n+url=https://x:${github}@example.com/r\n`,
                additions: 2,
                deletions: 0,
                status: "added",
              },
            ],
          })
          yield* pollWithTimeout(
            Effect.sync(() => (seen.length >= 1 ? true : undefined)),
            "timed out waiting for share sync",
            "5 seconds",
          )
          const body = seen.join("\n")
          expect(body).not.toContain(openai)
          expect(body).not.toContain(github)
          expect(body).toContain("[REDACTED:")
          expect(body).toContain("sec_123")
        }).pipe(Effect.provide(layer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
    30_000,
  )

  it.live("maskShareData masks every item and keeps the structure", () =>
    Effect.sync(() => {
      const out = ShareNext.maskShareData([
        { type: "message", data: { id: "msg_1", text: `key ${openai}` } },
        { type: "part", data: { id: "prt_1", messageID: "msg_1", state: { input: { command: `echo ${github}` } } } },
      ])
      const json = JSON.stringify(out)
      expect(json).not.toContain(openai)
      expect(json).not.toContain(github)
      expect((out[1].data as any).messageID).toBe("msg_1")
    }),
  )
})
