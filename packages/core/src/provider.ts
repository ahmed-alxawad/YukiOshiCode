export * as ProviderV2 from "./provider"

import { Types } from "effect"
import { Provider } from "@yukioshi/schema/provider"

export const ID = Provider.ID
export type ID = typeof ID.Type

/**
 * Providers intentionally shown by YukiOshi's connection picker. The Kimi
 * aliases cover both the current models.dev ID and its older catalog ID so a
 * catalog refresh does not make the provider disappear.
 */
export const SELECTED = {
  anthropic: "Claude (Anthropic)",
  openai: "Codex (OpenAI)",
  google: "Antigravity OAuth (Google)",
  xai: "Grok (xAI)",
  openrouter: "OpenRouter",
  agentrouter: "AgentRouter",
  opencode: "OpenCode",
  abacus: "Abacus",
  "kimi-code-plan-global": "Kimi",
  "kimi-for-coding": "Kimi",
  moonshotai: "Moonshot AI",
  zai: "Z.AI (GLM)",
  nvidia: "NVIDIA NIM",
} as const

export type SelectedID = keyof typeof SELECTED

export function isSelected(id: string): id is SelectedID {
  return Object.hasOwn(SELECTED, id)
}

export function selectedName(id: string) {
  return isSelected(id) ? SELECTED[id] : undefined
}

export const AISDK = Provider.AISDK

export const Native = Provider.Native

export const Api = Provider.Api
export type Api = Provider.Api
export type MutableApi<T extends Api = Api> = T extends Api
  ? Omit<Types.DeepMutable<T>, "settings"> & (undefined extends T["settings"] ? { settings?: any } : { settings: any })
  : never

export const Request = Provider.Request
export type Request = Provider.Request

export const Info = Provider.Info
export type Info = Provider.Info

export type MutableInfo = Omit<Types.DeepMutable<Info>, "api"> & { api: MutableApi }
