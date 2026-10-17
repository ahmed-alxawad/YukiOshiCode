import { PermissionV1 } from "@yukioshi/core/v1/permission"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
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

// The marker the webfetch tool attaches when the target resolved to a private address.
const privateMetadata = {
  private_address: {
    force_prompt: true,
    refuse_unattended: true,
    allow_private: false,
    warning: "This URL resolves to a private or local network address.",
    addresses: [{ address: "127.0.0.1", family: 4, reason: "IPv4 loopback address" }],
  },
}

const ALLOW_ALL = [{ permission: "*", pattern: "*", action: "allow" }] as const

type AskInput = Parameters<Permission.Interface["ask"]>[0]
type SessionIDValue = AskInput["sessionID"]

const askPrivate = (sessionID: SessionIDValue, ruleset: AskInput["ruleset"], metadata: Record<string, unknown> = privateMetadata) =>
  Permission.Service.pipe(
    Effect.flatMap((permission) =>
      permission.ask({
        sessionID,
        permission: "webfetch",
        patterns: ["http://127.0.0.1:1/"],
        metadata,
        always: [],
        ruleset,
      }),
    ),
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? (Cause.squash(exit.cause) as Error) : undefined)),
  )

const waitForPending = (permission: Permission.Interface, sessionID: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 2_000
    for (;;) {
      const pending = yield* permission.list()
      const mine = pending.filter((request) => request.sessionID === sessionID)
      if (mine.length > 0 || Date.now() > deadline) return mine
      yield* Effect.sleep(10)
    }
  })

// Runs the ask in the background and reports whether it reached a person (stayed pending)
// or was answered without asking. Rejects the pending ask so the fiber finishes.
const reachesAPerson = (sessionID: SessionIDValue, ruleset: AskInput["ruleset"], metadata?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* askPrivate(sessionID, ruleset, metadata).pipe(Effect.forkScoped)
    const mine = yield* waitForPending(permission, sessionID)
    if (mine.length === 0) {
      yield* Fiber.interrupt(fiber)
      return false
    }
    yield* permission.reply({ requestID: mine[0]!.id, reply: "reject" })
    const err = yield* Fiber.join(fiber)
    expect(err).toBeInstanceOf(PermissionV1.RejectedError)
    return true
  })

it.instance(
  "a private-address webfetch asks even when every rule allows it",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_webfetch_private_allow")
      const asked = yield* reachesAPerson(sessionID, [...ALLOW_ALL])
      expect(asked).toBe(true)
    }),
  { git: true },
)

it.instance(
  "auto-all mode does not answer a private-address webfetch",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_webfetch_private_autoall")
      const permission = yield* Permission.Service
      yield* permission.setMode(sessionID, "auto-all")
      const asked = yield* reachesAPerson(sessionID, [])
      expect(asked).toBe(true)
    }),
  { git: true },
)

it.instance(
  "a saved always-approval does not bypass the private-address prompt",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_webfetch_private_always")
      const permission = yield* Permission.Service

      // A public fetch that the user answers with "always" saves an approval...
      const fiber = yield* Effect.forkScoped(
        permission.ask({
          sessionID,
          permission: "webfetch",
          patterns: ["http://example.com/"],
          metadata: {},
          always: ["*"],
          ruleset: [],
        }),
      )
      const pending = yield* waitForPending(permission, sessionID)
      expect(pending.length).toBe(1)
      yield* permission.reply({ requestID: pending[0]!.id, reply: "always" })
      yield* Fiber.join(fiber)

      // ...which must not silence the private-address prompt.
      const asked = yield* reachesAPerson(sessionID, [...ALLOW_ALL])
      expect(asked).toBe(true)
    }),
  { git: true },
)

it.instance(
  "the review-mode reviewer may not allow a private-address webfetch",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_webfetch_private_review")
      const permission = yield* Permission.Service
      yield* permission.setMode(sessionID, "review")
      yield* permission.setReviewer(() =>
        Effect.succeed({ verdict: "allow" as const, reason: "the reviewer allows everything" }),
      )
      yield* Effect.addFinalizer(() => permission.setReviewer(undefined))

      // Control: the reviewer's allow settles a normal webfetch ask with no private marker.
      const settled = yield* askPrivate(sessionID, [], {})
      expect(settled).toBeUndefined()

      // The private-address ask is not the reviewer's to allow: it must reach a person.
      const asked = yield* reachesAPerson(sessionID, [])
      expect(asked).toBe(true)
    }),
  { git: true },
)

it.instance(
  "an explicit deny rule still refuses a private-address webfetch",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_webfetch_private_deny")
      const err = yield* askPrivate(sessionID, [{ permission: "webfetch", pattern: "*", action: "deny" }])
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(err!.message).toContain("specified a rule")
    }),
  { git: true },
)
