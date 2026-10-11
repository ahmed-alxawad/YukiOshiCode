import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@yukioshi/core/agent"
import { Database } from "@yukioshi/core/database/database"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { EventV2 } from "@yukioshi/core/event"
import { Location } from "@yukioshi/core/location"
import { PermissionV2 } from "@yukioshi/core/permission"
import { PermissionSaved } from "@yukioshi/core/permission/saved"
import { Project } from "@yukioshi/core/project"
import { ProjectTable } from "@yukioshi/core/project/sql"
import { AbsolutePath } from "@yukioshi/core/schema"
import { SessionV2 } from "@yukioshi/core/session"
import { SessionTable } from "@yukioshi/core/session/sql"
import { SessionStore } from "@yukioshi/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

const parent = SessionV2.ID.make("ses_plan_parent")
const child = SessionV2.ID.make("ses_plan_child")
const grandchild = SessionV2.ID.make("ses_plan_grandchild")
const other = SessionV2.ID.make("ses_plan_other")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const [id, parent_id] of [
    [parent, undefined],
    [child, parent],
    [grandchild, child],
    [other, undefined],
  ] as const) {
    yield* db
      .insert(SessionTable)
      .values({
        id,
        parent_id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) =>
    editor.update(AgentV2.ID.make("test"), (agent) => {
      agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
    }),
  )
})

const ask = (sessionID: SessionV2.ID, action: string) =>
  Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    return (yield* service.ask({
      id: PermissionV2.ID.create("per_test"),
      sessionID,
      action,
      resources: ["x"],
    })).effect
  })

describe("plan mode and subagent sessions (V2)", () => {
  it.effect("subagents of a plan-mode session cannot take mutating actions, reads still work", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      yield* service.setMode(parent, "plan")
      for (const id of [parent, child, grandchild]) {
        expect(yield* ask(id, "bash")).toBe("deny")
        expect(yield* ask(id, "edit")).toBe("deny")
        expect(yield* ask(id, "read")).toBe("allow")
      }
      expect(yield* ask(other, "bash")).toBe("allow")
    }),
  )

  it.effect("a subagent cannot leave plan mode on its own, and the parent leaving plan mode frees it", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      yield* service.setMode(parent, "plan")
      yield* service.setMode(child, "auto-all")
      expect(yield* ask(child, "bash")).toBe("deny")
      yield* service.setMode(parent, "manual")
      expect(yield* ask(child, "bash")).toBe("allow")
    }),
  )
})
