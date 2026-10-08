import { isAllowedRequestOrigin, type CorsOptions } from "@yukioshi/server/cors"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

// CSRF guard. CORS only stops a foreign page from reading responses; a body-less POST (dispose,
// abort, sync/start, ...) is a "simple" request that browsers send without a preflight. Browsers
// always attach Origin to cross-origin mutating requests, so refuse the ones from origins that are
// not allowed. Clients that send no Origin (CLI, SDK, curl) are unaffected.
export const originGuardLayer = (opts?: CorsOptions) =>
  HttpRouter.middleware<{ handles: unknown }>()((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (safeMethods.has(request.method)) return yield* effect
      if (isAllowedRequestOrigin(request.headers.origin, request.headers.host, opts)) return yield* effect
      return HttpServerResponse.jsonUnsafe({ error: "Forbidden: origin not allowed" }, { status: 403 })
    }),
  ).layer
