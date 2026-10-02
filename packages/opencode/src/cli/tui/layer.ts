import { run as runTui, type TuiInput } from "@yukioshi/tui"
import { Global } from "@yukioshi/core/global"
import { AppNodeBuilder } from "@yukioshi/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
