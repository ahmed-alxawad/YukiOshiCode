import { ServerAuth } from "@/server/auth"
import { isAllowedHost, isLoopbackBind, type CorsOptions } from "@yukioshi/server/cors"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// DNS-rebinding guard. An unauthenticated server bound to loopback trusts anything that can reach
// it, and a web page on a rebinding domain reaches it same-origin, with no CORS involved. Rejecting
// Host values that are not loopback names, IP literals or configured origins closes that path.
// With a password set the page has no credentials, so the check is not needed and proxies that
// rewrite Host keep working.
export const hostGuardLayer = (opts?: CorsOptions & { readonly hostname?: string }) =>
  HttpRouter.middleware<{ handles: unknown }>()(
    Effect.gen(function* () {
      const config = yield* ServerAuth.Config
      if (!isLoopbackBind(opts?.hostname) || ServerAuth.required(config)) return (effect) => effect
      return (effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (isAllowedHost(request.headers.host, opts)) return yield* effect
          return HttpServerResponse.jsonUnsafe({ error: "Forbidden: unexpected Host header" }, { status: 403 })
        })
    }),
  ).layer.pipe(Layer.provide(ServerAuth.Config.layer))
