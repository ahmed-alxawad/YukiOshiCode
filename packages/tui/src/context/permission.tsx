import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

/**
 * Same manual/auto/auto-all/plan modes as PermissionV2 and the legacy V1
 * permission service (packages/core/src/permission.ts,
 * packages/opencode/src/permission/index.ts). This context is purely
 * client-side: it decides whether *this* TUI auto-resolves a
 * "permission.asked" event locally (see context/sync.tsx) rather than
 * showing the approval prompt. It doesn't reach server-side state, so a
 * hard safety block still applies regardless of what's selected here.
 *
 * Plan mode is the exception: it must hold for every tool call, including the
 * ones the rules allow without asking, so the mode is also sent to the server
 * (`sync`) for the session. Other modes are only sent when leaving plan mode.
 */
export type PermissionMode = "manual" | "auto" | "auto-all" | "plan"

const CYCLE: readonly PermissionMode[] = ["manual", "auto", "auto-all", "plan"]

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const sdk = useSDK()
    const sent = new Map<string, PermissionMode>()
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
      /** Tells the server the mode for a session when it matters (plan mode, or leaving it). False if it could not. */
      async sync(sessionID: string) {
        const mode = store.mode
        const last = sent.get(sessionID) ?? "manual"
        if (mode === last) return true
        if (mode !== "plan" && last !== "plan") return true
        const result = await sdk.client.v2.session.permission.mode.set({ sessionID, mode }).catch(() => undefined)
        if (!result || result.error) return false
        sent.set(sessionID, mode)
        return true
      },
      toggle() {
        setStore("mode", (mode) => CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length])
      },
    }
  },
})
