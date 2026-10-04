import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@yukioshi/core/database/database"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { SessionProjector } from "@yukioshi/core/session/projector"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Ripgrep } from "@yukioshi/core/ripgrep"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, noopBootstrapReplacement, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@yukioshi/core/provider"
import { ModelV2 } from "@yukioshi/core/model"
import { SessionSearchTool } from "../../src/tool/session-search"
import { SessionTable } from "@yukioshi/core/session/sql"
import { ProjectTable } from "@yukioshi/core/project/sql"
import { ProjectV2 } from "@yukioshi/core/project"
import { AbsolutePath } from "@yukioshi/core/schema"
import { eq } from "drizzle-orm"
import type * as Tool from "../../src/tool/tool"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)], noopBootstrapReplacement],
  )

const it = testEffect(layer())

function ctxFor(sessionID: SessionID, agent = "build"): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_current"),
    callID: "",
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const seedSession = (opts: {
  title: string
  messages: Array<{
    role: "user" | "assistant"
    text: string
  }>
  timeUpdated?: number
}) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const { db } = yield* Database.Service
    const chat = yield* session.create({ title: opts.title })

    let parentID: MessageID | undefined
    for (const m of opts.messages) {
      const msgID = MessageID.ascending()
      if (m.role === "user") {
        yield* session.updateMessage({
          id: msgID,
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
      } else {
        yield* session.updateMessage({
          id: msgID,
          role: "assistant",
          parentID: parentID ?? MessageID.ascending(),
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          variant: "xhigh",
          time: { created: Date.now() },
        })
      }
      parentID = msgID

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msgID,
        sessionID: chat.id,
        type: "text",
        text: m.text,
      })
    }

    if (opts.timeUpdated !== undefined) {
      yield* db
        .update(SessionTable)
        .set({ time_updated: opts.timeUpdated })
        .where(eq(SessionTable.id, chat.id))
        .run()
        .pipe(Effect.orDie)
    }

    return chat
  })

describe("tool.session_search", () => {
  it.instance("registers in ToolRegistry as a builtin tool", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("session_search")

      const tool = (yield* registry.all()).find((t) => t.id === "session_search")
      expect(tool).toBeDefined()
    }),
  )

  it.instance("matches sessions containing all words in the query", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const toolInfo = yield* SessionSearchTool
      const tool = yield* toolInfo.init()

      const s1 = yield* seedSession({
        title: "Auth Fix",
        messages: [
          { role: "user", text: "How do we resolve the authentication bug?" },
          { role: "assistant", text: "We fixed the login flow by validating credentials." },
        ],
      })

      const s2 = yield* seedSession({
        title: "Database Migration",
        messages: [
          { role: "user", text: "Let's perform database migrations." },
          { role: "assistant", text: "Postgres schema updated successfully." },
        ],
      })

      const current = yield* seedSession({
        title: "Active Working Session",
        messages: [{ role: "user", text: "Current conversation text." }],
      })
      const ctx = ctxFor(current.id)

      // Query has multiple words: both "authentication" and "login"
      const res1 = yield* tool.execute({ query: "authentication login" }, ctx)
      expect(res1.metadata.matches).toBe(1)
      expect(res1.metadata.sessions).toEqual([s1.id])
      expect(res1.output).toContain("Session: Auth Fix")
      expect(res1.output).toContain(s1.id)

      // Query has words where one is present in s1 and one in s2, but neither has both
      const res2 = yield* tool.execute({ query: "authentication database" }, ctx)
      expect(res2.metadata.matches).toBe(0)
      expect(res2.metadata.sessions).toEqual([])
      expect(res2.output).toContain('No sessions matched "authentication database".')
    }),
  )

  it.instance("matches case-insensitively", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const toolInfo = yield* SessionSearchTool
      const tool = yield* toolInfo.init()

      const s1 = yield* seedSession({
        title: "OAuth2 Provider Setup",
        messages: [
          { role: "user", text: "How to configure provider?" },
          { role: "assistant", text: "Set GOOGLE_CLIENT_ID and client_secret in your environment." },
        ],
      })

      const current = yield* seedSession({
        title: "Active Working Session",
        messages: [{ role: "user", text: "Current chat" }],
      })
      const ctx = ctxFor(current.id)

      // Query has lowercase "google_client_id" (text has uppercase)
      // and uppercase "CLIENT_SECRET" (text has lowercase)
      const res = yield* tool.execute({ query: "google_client_id CLIENT_SECRET" }, ctx)
      expect(res.metadata.matches).toBe(1)
      expect(res.metadata.sessions).toEqual([s1.id])
      expect(res.output).toContain("GOOGLE_CLIENT_ID and client_secret")
    }),
  )

  it.instance("excludes the current session from search results", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const toolInfo = yield* SessionSearchTool
      const tool = yield* toolInfo.init()

      const current = yield* seedSession({
        title: "Current Active Session",
        messages: [
          { role: "user", text: "SecretTokenxyz inside the current session" },
          { role: "assistant", text: "I have stored SecretTokenxyz safely." },
        ],
      })
      const ctx = ctxFor(current.id)

      const res = yield* tool.execute({ query: "SecretTokenxyz" }, ctx)
      expect(res.metadata.matches).toBe(0)
      expect(res.metadata.sessions).toEqual([])
      expect(res.output).toContain('No sessions matched "SecretTokenxyz".')
    }),
  )

  it.instance("respects the limit parameter and orders by newest first", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const toolInfo = yield* SessionSearchTool
      const tool = yield* toolInfo.init()

      const now = Date.now()
      const s1 = yield* seedSession({
        title: "Oldest Login Session",
        timeUpdated: now - 3000,
        messages: [{ role: "user", text: "Working on login redesign" }],
      })
      const s2 = yield* seedSession({
        title: "Middle Login Session",
        timeUpdated: now - 2000,
        messages: [{ role: "user", text: "Working on login flow" }],
      })
      const s3 = yield* seedSession({
        title: "Newest Login Session",
        timeUpdated: now - 1000,
        messages: [{ role: "user", text: "Working on login tests" }],
      })

      const current = yield* seedSession({
        title: "Active Session",
        messages: [{ role: "user", text: "Current conversation" }],
      })
      const ctx = ctxFor(current.id)

      const res = yield* tool.execute({ query: "login", limit: 2 }, ctx)
      expect(res.metadata.matches).toBe(2)
      expect(res.metadata.sessions).toEqual([s3.id, s2.id])
      expect(res.output).toContain(s3.id)
      expect(res.output).toContain(s2.id)
      expect(res.output).not.toContain(s1.id)
    }),
  )

  it.instance("supports scope 'project' vs 'all'", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const toolInfo = yield* SessionSearchTool
      const tool = yield* toolInfo.init()
      const { db } = yield* Database.Service

      const otherProjectID = ProjectV2.ID.make("proj_other_external")
      yield* db
        .insert(ProjectTable)
        .values({
          id: otherProjectID,
          worktree: AbsolutePath.make("/external/project"),
          vcs: null,
          name: "external",
          time_created: Date.now(),
          time_updated: Date.now(),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)

      const otherSession = yield* seedSession({
        title: "External Project Session",
        messages: [{ role: "user", text: "Deploying kubernetes cluster pods" }],
      })

      yield* db
        .update(SessionTable)
        .set({ project_id: otherProjectID })
        .where(eq(SessionTable.id, otherSession.id))
        .run()
        .pipe(Effect.orDie)

      const current = yield* seedSession({
        title: "Current Session",
        messages: [{ role: "user", text: "Active work" }],
      })
      const ctx = ctxFor(current.id)

      // Scope: project (default) should not find otherSession
      const resProjectDefault = yield* tool.execute({ query: "kubernetes pods" }, ctx)
      expect(resProjectDefault.metadata.matches).toBe(0)
      expect(resProjectDefault.metadata.sessions).toEqual([])

      const resProjectExplicit = yield* tool.execute({ query: "kubernetes pods", scope: "project" }, ctx)
      expect(resProjectExplicit.metadata.matches).toBe(0)

      // Scope: all should find otherSession
      const resAll = yield* tool.execute({ query: "kubernetes pods", scope: "all" }, ctx)
      expect(resAll.metadata.matches).toBe(1)
      expect(resAll.metadata.sessions).toEqual([otherSession.id])
      expect(resAll.output).toContain("External Project Session")
      expect(resAll.output).toContain(otherSession.id)
    }),
  )

  it.instance("returns clear message when no sessions match", () =>
    Effect.gen(function* () {
      yield* TestInstance
      const toolInfo = yield* SessionSearchTool
      const tool = yield* toolInfo.init()

      const current = yield* seedSession({
        title: "Current Session",
        messages: [{ role: "user", text: "Hello world" }],
      })
      const ctx = ctxFor(current.id)

      const res = yield* tool.execute({ query: "nonexistentquerykeyword" }, ctx)
      expect(res.metadata.matches).toBe(0)
      expect(res.metadata.sessions).toEqual([])
      expect(res.title).toBe('Session search: "nonexistentquerykeyword"')
      expect(res.output).toBe('No sessions matched "nonexistentquerykeyword".')
    }),
  )
})
