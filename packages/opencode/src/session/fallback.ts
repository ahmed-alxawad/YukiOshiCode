// Fallback models: when a step fails because of the provider (rate limit, overload, server error,
// billing or sign-in failure) and the normal retries did not help, the turn continues on the next model
// in `fallback.models`. Problems a different model would not fix (the user stopping the turn, a
// content filter, a conversation that is too long) never switch models.

import fs from "fs/promises"
import path from "path"
import { Global } from "@yukioshi/core/global"

export const DEFAULT_COOLDOWN_S = 300

const PROVIDER_STATUS = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504, 520, 522, 524, 529])
const PROVIDER_MESSAGE = /rate.?limit|quota|overloaded|capacity|insufficient|billing|unavailable|credit/i

type MessageError = { name: string; data?: Record<string, unknown> } | undefined

/** True when another provider or model could plausibly finish the step. */
export function eligible(error: MessageError) {
  if (!error) return false
  if (error.name === "ProviderAuthError") return true
  if (error.name !== "APIError") return false
  const data = error.data ?? {}
  const status = typeof data.statusCode === "number" ? data.statusCode : undefined
  if (status !== undefined && PROVIDER_STATUS.has(status)) return true
  if (data.isRetryable === true) return true
  return typeof data.message === "string" && PROVIDER_MESSAGE.test(data.message)
}

/** The configured fallback models still to try, in order, as "provider/model". */
export function candidates(models: readonly string[] | undefined, tried: ReadonlySet<string>) {
  return (models ?? []).map((item) => item.trim()).filter((item) => item.includes("/") && !tried.has(item))
}

// A model that failed over rests for `fallback.cooldown` seconds. Turns in that time start on the model
// that took over, so they don't fail, wait out retries, and print the same error again first. Kept in
// the state folder so separate `yukioshi run` calls share it.
type Resting = Record<string, { until: number; to: string }>

const restFile = (state: string) => path.join(state, "fallback-rest.json")

async function readRest(state: string): Promise<Resting> {
  try {
    const value = JSON.parse(await fs.readFile(restFile(state), "utf8"))
    return value && typeof value === "object" ? (value as Resting) : {}
  } catch {
    return {}
  }
}

/** Records that `model` failed over to `to`; it rests for `seconds`. */
export async function rest(model: string, to: string, seconds: number, now = Date.now(), state = Global.Path.state) {
  if (seconds <= 0) return
  const resting = Object.fromEntries(Object.entries(await readRest(state)).filter(([, entry]) => entry.until > now))
  resting[model] = { until: now + seconds * 1000, to }
  await fs.mkdir(state, { recursive: true })
  const tmp = `${restFile(state)}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(resting))
  await fs.rename(tmp, restFile(state))
}

/**
 * The model to start on instead of `model` while it rests, following a chain of rested models
 * (A rested to B, B rested to C) a few steps at most. Undefined when `model` is not resting.
 */
export async function restingTarget(model: string, now = Date.now(), state = Global.Path.state) {
  const resting = await readRest(state)
  let current = model
  const seen = new Set([model])
  for (let hop = 0; hop < 4; hop++) {
    const entry = resting[current]
    if (!entry || entry.until <= now || seen.has(entry.to)) break
    current = entry.to
    seen.add(current)
  }
  return current === model ? undefined : current
}

export * as SessionFallback from "./fallback"
