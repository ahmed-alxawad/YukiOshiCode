import { PermissionV1 } from "@yukioshi/core/v1/permission"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { LayerNode } from "@yukioshi/core/effect/layer-node"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const refusal = (mode: Permission.Mode, ruleset: Parameters<Permission.Interface["ask"]>[0]["ruleset"]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const sessionID = SessionID.make("session_refusal_" + mode)
    yield* permission.setMode(sessionID, mode)
    const exit = yield* permission
      .ask({ sessionID, permission: "bash", patterns: ["ls"], metadata: {}, always: [], ruleset })
      .pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause) as Error
    throw new Error("expected refusal")
  })

it.instance(
  "plan mode refusal names the mode, not a rule",
  () =>
    Effect.gen(function* () {
      const err = yield* refusal("plan", [{ permission: "*", pattern: "*", action: "allow" }])
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(err.message).toContain("Plan mode refused")
      expect(err.message).not.toContain("rule")
      expect(err.message).not.toContain('"action":"allow"')
    }),
  { git: true },
)

it.instance(
  "a deny rule outside plan mode still reports the rule",
  () =>
    Effect.gen(function* () {
      const err = yield* refusal("manual", [{ permission: "bash", pattern: "*", action: "deny" }])
      expect(err.message).toContain("specified a rule")
    }),
  { git: true },
)
