// An in-process stand-in for the Kothora API. It follows contracts/README.md of the Kothora backend:
// errors are {"error": {"code", "message", "request_id"}} and a client reads `code`.
export type Handler = (request: { path: string; init: RequestInit; headers: Headers; body: any }) => Response | Promise<Response>

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

export const apiError = (status: number, code: string, headers: Record<string, string> = {}) =>
  json({ error: { code, message: `fallback message for ${code}`, request_id: "req-test-0001" } }, status, headers)

export const tokenOut = (n: number) => ({
  access_token: `kca_access${n}`,
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: `kcr_refresh${n}`,
  refresh_expires_in: 2592000,
  device_id: "11111111-1111-4111-8111-111111111111",
})

export function fakeServer(routes: Record<string, Handler | Handler[]>) {
  const calls: { path: string; headers: Headers; body: any }[] = []
  const counters = new Map<string, number>()
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(input).pathname
    const headers = new Headers(init.headers)
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, headers, body })
    const route = routes[path]
    if (!route) return apiError(404, "not_found")
    if (Array.isArray(route)) {
      const n = counters.get(path) ?? 0
      counters.set(path, n + 1)
      return route[Math.min(n, route.length - 1)]({ path, init, headers, body })
    }
    return route({ path, init, headers, body })
  }
  return { fetch, calls, count: (path: string) => calls.filter((call) => call.path === path).length }
}

/** A fetch that fails like a dropped mobile connection. */
export const networkDown = (): Response => {
  throw new TypeError("fetch failed")
}
