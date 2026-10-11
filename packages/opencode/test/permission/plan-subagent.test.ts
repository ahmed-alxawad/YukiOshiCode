import { PermissionV1 } from "@yukioshi/core/v1/permission"
import { PermissionV2 } from "@yukioshi/core/permission"
import { Permission as PermissionSchema } from "@yukioshi/schema/permission"
import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session/session"
import { SessionProjector } from "@yukioshi/core/session/projector"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { Layer } from "effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node, Session.node, SessionProjector.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const allow = [{ permission: "*", pattern: "*", action: "allow" as const }]

const ask = (sessionID: Session.Info["id"], permission: string) =>
  Effect.gen(function* () {
    const service = yield* Permission.Service
    const exit = yield* service
      .ask({ sessionID, permission, patterns: ["x"], metadata: {}, always: [], ruleset: allow })
      .pipe(Effect.exit)
    return Exit.isFailure(exit) ? (Cause.squash(exit.cause) as Error) : undefined
  })

const family = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "parent" })
  const child = yield* sessions.create({ title: "child", parentID: parent.id })
  const grandchild = yield* sessions.create({ title: "grandchild", parentID: child.id })
  const other = yield* sessions.create({ title: "other" })
  return { parent: parent.id, child: child.id, grandchild: grandchild.id, other: other.id }
})

// The same event the TUI and `yukioshi run --mode` cause through the session permission mode endpoint.
const setThroughApi = (sessionID: string, mode: PermissionV2.Mode) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    yield* events.publish(PermissionSchema.Event.ModeChanged, { sessionID: sessionID as never, mode })
  })

it.instance(
  "a mode set through the API makes plan mode refuse allowed actions and keep reads, in every subagent depth",
  () =>
    Effect.gen(function* () {
      const ids = yield* family
      yield* setThroughApi(ids.parent, "plan")
      for (const id of [ids.parent, ids.child, ids.grandchild]) {
        for (const tool of ["bash", "edit", "write", "apply_patch", "delegate", "task", "task_parallel"]) {
          const err = yield* ask(id, tool)
          expect(err).toBeInstanceOf(PermissionV1.DeniedError)
          expect(err?.message).toContain("Plan mode refused")
        }
        for (const tool of ["read", "grep", "glob", "list", "todowrite", "question"]) {
          expect(yield* ask(id, tool)).toBeUndefined()
        }
      }
      expect(yield* ask(ids.other, "bash")).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "a subagent cannot leave plan mode itself, and leaving plan mode in the parent frees it",
  () =>
    Effect.gen(function* () {
      const ids = yield* family
      const permission = yield* Permission.Service
      yield* setThroughApi(ids.parent, "plan")
      yield* permission.setMode(ids.child, "auto-all")
      yield* setThroughApi(ids.child, "auto-all")
      expect(yield* ask(ids.child, "bash")).toBeInstanceOf(PermissionV1.DeniedError)
      yield* setThroughApi(ids.parent, "manual")
      expect(yield* ask(ids.child, "bash")).toBeUndefined()
      expect(yield* ask(ids.parent, "bash")).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "modes other than plan are not inherited by subagents",
  () =>
    Effect.gen(function* () {
      const ids = yield* family
      yield* setThroughApi(ids.parent, "auto-all")
      const permission = yield* Permission.Service
      expect(yield* permission.getMode(ids.child)).toBe("manual")
      const service = yield* Permission.Service
      const exit = yield* service
        .ask({
          sessionID: ids.child,
          permission: "bash",
          patterns: ["x"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "*", pattern: "*", action: "deny" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { git: true },
)
