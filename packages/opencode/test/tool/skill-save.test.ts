import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SkillSaveTool } from "@/tool/skill-save"
import { Skill } from "@/skill"
import { Global } from "@yukioshi/core/global"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { SessionID, MessageID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import type { PermissionV1 } from "@yukioshi/core/v1/permission"

import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"

const fakeTruncate = Truncate.Service.of({
  output: (content: string) => Effect.succeed({ content, truncated: false }),
} as any)

const it = testEffect(
  Layer.mergeAll(
    Layer.succeed(Agent.Service, {
      get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} }),
    } as any),
    Layer.succeed(Truncate.Service, fakeTruncate),
    Layer.succeed(Global.Service, {
      data: "/var/tmp/yk-test/data",
      cache: "/var/tmp/yk-test/cache",
      config: "/var/tmp/yk-test/config",
      state: "/var/tmp/yk-test/state",
    } as any),
    Layer.succeed(Skill.Service, {
      get: () => Effect.succeed(undefined),
    } as any),
    TestConfig.layer({
      get: () =>
        Effect.succeed({
          skills: { learn: { enabled: true, max: 10, staleDays: 30 } } as any,
        } as any),
    }),
  ),
)

describe("skill_save tool", () => {
  it.instance("includes full content in permission request metadata on save", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SkillSaveTool
      const tool = yield* toolInfo.init()
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        callID: "call_1",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (req) =>
          Effect.sync(() => {
            requests.push(req)
          }),
      }

      yield* tool.execute(
        {
          action: "save",
          name: "verify-code-format",
          description: "Verify that formatting rules are strictly applied",
          content: "Always check biome or prettier before committing any code changes.",
        },
        ctx,
      )

      expect(requests.length).toBe(1)
      expect(requests[0].permission).toBe("skill_save")
      expect(requests[0].patterns).toEqual(["verify-code-format"])
      expect(requests[0].metadata).toEqual({
        action: "save",
        name: "verify-code-format",
        description: "Verify that formatting rules are strictly applied",
        content: "Always check biome or prettier before committing any code changes.",
      })
    }),
  )
})
