import type { Hooks, PluginInput } from "@yukioshi/plugin"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { setTimeout as sleep } from "node:timers/promises"

// Kothora Code device-code sign-in (RFC 8628). YukiOshi never opens a browser for it: it shows the
// verification URL and the user code, the user approves on any device, and this plugin polls the
// Kothora backend until the token is issued, the request is rejected, or it expires.
//
// Kothora models are gateway-only: they are reached through model gateways (see the gateway
// plugins), so this plugin only signs in. It holds no secrets - nothing in this repo does.

/** Kothora backend. KOTHORA_BASE_URL overrides it for self-hosted or test deployments. */
const DEFAULT_BASE_URL = "https://kothora.com"
/** Sign-in and token requests must not wait forever on a server that never answers. */
const REQUEST_TIMEOUT_MS = 30_000
/** RFC 8628 section 3.5: after slow_down the polling interval grows by 5 seconds. */
const SLOW_DOWN_INCREMENT_S = 5
/** Used when the backend does not send an expires_in. */
const DEFAULT_EXPIRES_IN_S = 600
/** Safety net so a misbehaving backend cannot keep the poll loop alive forever. */
const MAX_POLLS = 1000

const CLIENT_NAME = "YukiOshi"

type DeviceAuthorization = {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

type DeviceToken = {
  access_token?: string
  error?: string
}

type Sleep = (ms: number) => Promise<unknown>

function kothoraBaseUrl() {
  return process.env.KOTHORA_BASE_URL ?? DEFAULT_BASE_URL
}

/**
 * Kothora sign-in with the sleep injectable, so tests can observe the polling rhythm without
 * waiting for it. KothoraAuthPlugin is the real entry point; this factory exists for tests.
 */
export function createKothoraAuthHooks(options: { sleep?: Sleep } = {}): Hooks {
  const doSleep = options.sleep ?? ((ms: number) => sleep(ms))
  return {
    auth: {
      provider: "kothora",
      methods: [
        {
          type: "oauth",
          label: "Sign in to Kothora (device code)",
          authorize: async () => {
            const base = kothoraBaseUrl()
            const response = await fetch(`${base}/code/device/authorize`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "User-Agent": `yukioshi/${InstallationVersion}` },
              body: JSON.stringify({ client_name: CLIENT_NAME, platform: process.platform }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            if (!response.ok) throw new Error("Failed to start the Kothora device sign-in")
            const device = (await response.json()) as DeviceAuthorization
            if (!device.device_code || !device.user_code || !device.verification_uri) {
              throw new Error("Kothora sent an incomplete device sign-in response")
            }
            const interval = typeof device.interval === "number" && device.interval >= 0 ? device.interval : 5
            const expiresIn =
              typeof device.expires_in === "number" && device.expires_in > 0 ? device.expires_in : DEFAULT_EXPIRES_IN_S
            const expiresAt = Date.now() + expiresIn * 1000

            return {
              url: device.verification_uri,
              instructions: `Open ${device.verification_uri} on any device, sign in, and approve this request with the code ${device.user_code}. This window keeps waiting until you approve, reject, or the request expires.`,
              method: "auto" as const,
              callback: async () => {
                let intervalSeconds = interval
                for (let poll = 0; poll < MAX_POLLS && Date.now() < expiresAt; poll++) {
                  const tokenResponse = await fetch(`${base}/code/device/token`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "User-Agent": `yukioshi/${InstallationVersion}` },
                    body: JSON.stringify({ device_code: device.device_code }),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                  }).catch(() => undefined)

                  if (!tokenResponse) {
                    // One unreachable poll is not a failed sign-in: the backend may hiccup while the user approves.
                    await doSleep(intervalSeconds * 1000)
                    continue
                  }

                  const token = (await tokenResponse.json().catch(() => undefined)) as DeviceToken | undefined
                  if (tokenResponse.ok && token?.access_token) {
                    return { type: "success" as const, key: token.access_token }
                  }

                  if (token?.error === "authorization_pending") {
                    await doSleep(intervalSeconds * 1000)
                    continue
                  }
                  if (token?.error === "slow_down") {
                    intervalSeconds += SLOW_DOWN_INCREMENT_S
                    await doSleep(intervalSeconds * 1000)
                    continue
                  }
                  // expired_token, rejected, the device limit (403) and anything unknown cannot recover.
                  return { type: "failed" as const }
                }
                return { type: "failed" as const }
              },
            }
          },
        },
      ],
    },
  }
}

/** Kothora through device-code sign-in (RFC 8628). */
export async function KothoraAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return createKothoraAuthHooks()
}
