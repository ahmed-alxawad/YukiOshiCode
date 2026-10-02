import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"

/**
 * Same manual/auto/auto-all/plan modes as PermissionV2 and the legacy V1
 * permission service (packages/core/src/permission.ts,
 * packages/opencode/src/permission/index.ts). This context is purely
 * client-side: it decides whether *this* TUI auto-resolves a
 * "permission.asked" event locally (see context/sync.tsx) rather than
 * showing the approval prompt. It doesn't reach server-side state, so a
 * hard safety block still applies regardless of what's selected here.
 */
export type PermissionMode = "manual" | "auto" | "auto-all" | "plan"

const CYCLE: readonly PermissionMode[] = ["manual", "auto", "auto-all", "plan"]

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const [store, setStore] = createStore<{ mode: PermissionMode }>({
      mode: args.auto ? "auto-all" : "manual",
    })
    return {
      get mode() {
        return store.mode
      },
      set(mode: PermissionMode) {
        setStore("mode", mode)
      },
      toggle() {
        setStore("mode", (mode) => CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length])
      },
    }
  },
})
