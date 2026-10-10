import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, noopBootstrapReplacement } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"

const directories = () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")]))
const root = LayerNode.group([ToolRegistry.node, Agent.node])
const build = (flags: Parameters<typeof RuntimeFlags.layer>[0], config?: Record<string, unknown>) =>
  testEffect(
    LayerNode.compile(root, [
      [Config.node, TestConfig.layer({ directories, ...(config ? { get: () => Effect.succeed(config) } : {}) } as never)],
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
      noopBootstrapReplacement,
    ]),
  )

const off = build({})
const byFlag = build({ backgroundShell: true })
const byConfig = build({}, { background_shell: { enabled: true } })

afterEach(async () => {
  await disposeAllInstances()
})

const NAMES = ["monitor", "job_list", "job_stop"]

describe("background shell tools in the registry", () => {
  off.instance("are absent by default", () =>
    Effect.gen(function* () {
      const ids = yield* (yield* ToolRegistry.Service).ids()
      for (const name of NAMES) expect(ids).not.toContain(name)
      expect(ids).toContain("bash")
    }),
  )

  byFlag.instance("appear with YUKIOSHI_BACKGROUND_SHELL", () =>
    Effect.gen(function* () {
      const ids = yield* (yield* ToolRegistry.Service).ids()
      for (const name of NAMES) expect(ids).toContain(name)
    }),
  )

  byConfig.instance("appear with background_shell.enabled", () =>
    Effect.gen(function* () {
      const ids = yield* (yield* ToolRegistry.Service).ids()
      for (const name of NAMES) expect(ids).toContain(name)
    }),
  )
})
