import { afterEach, expect } from "bun:test"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { resolve } from "@yukioshi/core/edition"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const agents = (edition: ReturnType<typeof resolve>) =>
  testEffect(
    LayerNode.compile(
      LayerNode.group([Agent.nodeWith(edition), Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
      [[RuntimeFlags.node, RuntimeFlags.layer({})]],
    ),
  )

const kothora = agents(resolve("kothora", undefined))
const yukioshi = agents(resolve("yukioshi", undefined))

afterEach(async () => {
  await disposeAllInstances()
})

kothora.instance("the Kothora edition has a native Learn mode after Research and before Auto", () =>
  Effect.gen(function* () {
    const primary = (yield* Agent.Service.use((svc) => svc.list())).filter((a) => a.mode !== "subagent" && !a.hidden)
    expect(primary.map((a) => a.name)).toEqual(["build", "plan", "goal", "reasoning", "research", "learn", "auto"])
    const learn = primary.find((a) => a.name === "learn")!
    expect(learn.native).toBe(true)
    // Learn mode may edit files; the prompt makes it explain first. Questions to the student are allowed.
    expect(Permission.evaluate("edit", "src/index.ts", learn.permission).action).toBe("allow")
    expect(Permission.evaluate("question", "*", learn.permission).action).toBe("allow")
  }),
)

yukioshi.instance("the yukioshi edition has no Learn mode and keeps its modes unchanged", () =>
  Effect.gen(function* () {
    const list = yield* Agent.Service.use((svc) => svc.list())
    expect(list.some((a) => a.name === "learn")).toBe(false)
    const primary = list.filter((a) => a.mode !== "subagent" && !a.hidden)
    expect(primary.map((a) => a.name)).toEqual(["build", "plan", "goal", "reasoning", "research", "auto"])
  }),
)

kothora.instance(
  "a config agent with its own prompt named learn stays the user's agent",
  () =>
    Effect.gen(function* () {
      const learn = (yield* Agent.Service.use((svc) => svc.get("learn")))!
      expect(learn.native).toBe(false)
      expect(learn.prompt).toBe("My own tutor.")
    }),
  { config: { agent: { learn: { prompt: "My own tutor." } } } },
)
