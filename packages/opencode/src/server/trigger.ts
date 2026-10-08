import { Config } from "@/config/config"
import { createOpencodeClient, type OpencodeClient } from "@yukioshi/sdk/v2"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ConfigV1 } from "@yukioshi/core/v1/config/config"

export type ResolvedTriggers =
  | {
      readonly enabled: true
      readonly token: string
      readonly directories: readonly string[]
      readonly mode: "review" | "plan"
    }
  | {
      readonly enabled: false
      readonly reason?: string
    }

export function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8")
  const bufB = Buffer.from(b, "utf-8")
  const hashA = crypto.createHash("sha256").update(bufA).digest()
  const hashB = crypto.createHash("sha256").update(bufB).digest()
  return crypto.timingSafeEqual(hashA, hashB) && bufA.length === bufB.length
}

export function resolveTriggers(config: ConfigV1.Info): ResolvedTriggers {
  const triggers = config.triggers
  if (!triggers?.enabled) {
    return { enabled: false }
  }
  const tokenEnv = triggers.token_env
  if (!tokenEnv || tokenEnv.trim().length === 0) {
    const reason = "Triggers: refused to enable because 'token_env' is not set."
    return { enabled: false, reason }
  }
  const token = process.env[tokenEnv]
  if (!token || token.trim().length === 0) {
    const reason = `Triggers: refused to enable because environment variable '${tokenEnv}' is unset.`
    return { enabled: false, reason }
  }
  if (token.length < 32) {
    const reason = `Triggers: refused to enable because environment variable '${tokenEnv}' is shorter than 32 characters (${token.length} chars).`
    return { enabled: false, reason }
  }
  const mode = triggers.mode === "plan" ? "plan" : "review"
  return {
    enabled: true,
    token,
    directories: triggers.directories ?? [],
    mode,
  }
}

function pickModel(value?: string) {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  }
}

const activeDirectories = new Set<string>()

export function isDirectoryBusy(directory: string): boolean {
  return activeDirectories.has(path.resolve(directory))
}

export function clearActiveDirectoriesForTest(): void {
  activeDirectories.clear()
}

async function startBackgroundRun(opts: {
  sdk: OpencodeClient
  sessionID: string
  prompt: string
  model?: string
  directory: string
}) {
  const { sdk, sessionID, prompt, model, directory } = opts
  try {
    const modelInput = pickModel(model)

    const events = await sdk.event.subscribe()
    let loopDone = false

    const eventLoop = (async () => {
      try {
        for await (const event of events.stream) {
          if (loopDone) break
          if (event.type === "permission.asked") {
            const perm = event.properties
            if (perm.sessionID !== sessionID) continue
            // In unattended trigger mode, any ask reaching the user (not auto-allowed
            // by rules or the review model) is auto-rejected
            await sdk.permission.reply({ requestID: perm.id, reply: "reject" }).catch(() => {})
          }
          if (
            event.type === "session.status" &&
            event.properties.sessionID === sessionID &&
            event.properties.status.type === "idle"
          ) {
            break
          }
        }
      } catch {
        // Stream closed
      }
    })()

    await sdk.session.prompt({
      sessionID,
      model: modelInput,
      parts: [{ type: "text", text: prompt }],
    }).catch(() => {})

    loopDone = true
    await Promise.race([
      eventLoop.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ])
  } catch (err) {
    console.error("Trigger background run error:", err)
  } finally {
    activeDirectories.delete(directory)
  }
}

export const handleTrigger = (
  request: HttpServerRequest.HttpServerRequest,
  configSvc: Config.Interface,
  options?: { sdk?: OpencodeClient },
) => {
  let lockedDir: string | undefined
  return Effect.gen(function* () {
    const globalConfig = yield* configSvc.getGlobal().pipe(Effect.orDie)

    const resolved = resolveTriggers(globalConfig)
    if (!resolved.enabled) {
      if (resolved.reason) {
        yield* Effect.logWarning(resolved.reason)
      }
      return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
    }

    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return HttpServerResponse.jsonUnsafe({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7).trim()
    if (!constantTimeCompare(token, resolved.token)) {
      return HttpServerResponse.jsonUnsafe({ error: "Unauthorized" }, { status: 401 })
    }

    const contentType = request.headers["content-type"]
    if (!contentType || !contentType.toLowerCase().startsWith("application/json")) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Unsupported Media Type: Content-Type must be application/json" },
        { status: 415 },
      )
    }

    const contentLengthHeader = request.headers["content-length"]
    if (contentLengthHeader !== undefined) {
      const len = Number(contentLengthHeader)
      if (Number.isFinite(len) && len > 65_536) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Payload too large: body must not exceed 64 KB" },
          { status: 413 },
        )
      }
    }

    const rawBody = yield* Effect.orDie(request.text)
    if (Buffer.byteLength(rawBody, "utf-8") > 65_536) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Payload too large: body must not exceed 64 KB" },
        { status: 413 },
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid JSON" }, { status: 400 })
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return HttpServerResponse.jsonUnsafe({ error: "Body must be a JSON object" }, { status: 400 })
    }

    const obj = parsed as Record<string, unknown>
    const allowedKeys = new Set(["prompt", "directory", "model"])
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) {
        return HttpServerResponse.jsonUnsafe({ error: `Unknown field: '${key}'` }, { status: 400 })
      }
    }

    if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0) {
      return HttpServerResponse.jsonUnsafe({ error: "Field 'prompt' must be a non-empty string" }, { status: 400 })
    }

    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(obj.prompt)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Field 'prompt' must not contain control characters" },
        { status: 400 },
      )
    }

    if (obj.model !== undefined && (typeof obj.model !== "string" || obj.model.trim().length === 0)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Field 'model' must be a string in provider/model format" },
        { status: 400 },
      )
    }

    if (typeof obj.directory !== "string" || obj.directory.trim().length === 0) {
      return HttpServerResponse.jsonUnsafe({ error: "Field 'directory' must be a non-empty string" }, { status: 400 })
    }

    if (obj.directory.includes("..")) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Forbidden: directory path must not contain '..'" },
        { status: 403 },
      )
    }

    const resolvedDir = path.resolve(obj.directory)
    const realDir = yield* Effect.promise(() => fs.realpath(resolvedDir).catch(() => resolvedDir))
    const realAllowed = yield* Effect.promise(() =>
      Promise.all(
        resolved.directories.map((d) => fs.realpath(path.resolve(d)).catch(() => path.resolve(d))),
      ),
    )
    if (!realAllowed.includes(realDir)) {
      return HttpServerResponse.jsonUnsafe({ error: "Forbidden: directory not allowed" }, { status: 403 })
    }

    if (activeDirectories.has(realDir)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Conflict: a run is already active in this directory" },
        { status: 409 },
      )
    }
    activeDirectories.add(realDir)
    lockedDir = realDir

    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const headers = new Headers(req.headers)
      const auth = ServerAuth.header()
      if (auth) headers.set("Authorization", auth)
      return Server.Default().app.fetch(new Request(req, { headers }))
    }) as typeof globalThis.fetch

    const sdk =
      options?.sdk ??
      createOpencodeClient({
        baseUrl: "http://yukioshi.internal",
        fetch: fetchFn,
        directory: realDir,
      })

    const modelInput = pickModel(obj.model as string | undefined)
    const sessResult = yield* Effect.promise(() =>
      sdk.session.create({
        title: `Trigger: ${(obj.prompt as string).slice(0, 50)}`,
        model: modelInput ? { providerID: modelInput.providerID, id: modelInput.modelID } : undefined,
      }),
    )

    const sessionID = sessResult.data?.id
    if (!sessionID) {
      throw new Error("Failed to create session")
    }

    const setResult = yield* Effect.promise(() =>
      sdk.v2.session.permission.mode.set({ sessionID, mode: resolved.mode }).catch((err) => ({ error: err })),
    )

    const getResult = yield* Effect.promise(() =>
      sdk.v2.session.permission.mode.get({ sessionID }).catch((err) => ({ error: err })),
    )

    const getData = "data" in getResult ? getResult.data : undefined
    const appliedMode = (getData as any)?.data ?? getData
    const hasError = Boolean((setResult as any).error || (getResult as any).error)
    if (hasError || appliedMode !== resolved.mode) {
      activeDirectories.delete(realDir)
      lockedDir = undefined
      return HttpServerResponse.jsonUnsafe(
        { error: "could not start the run safely" },
        { status: 500 },
      )
    }

    if (globalConfig.audit?.enabled === true) {
      const { writeEntry } = yield* Effect.promise(() => import("@/audit"))
      const { Redact } = yield* Effect.promise(() => import("@yukioshi/core/redact"))
      yield* Effect.promise(() =>
        writeEntry(
          {
            event: "trigger",
            session: sessionID,
            prompt: Redact.mask(obj.prompt as string),
            mode: resolved.mode,
            ...(obj.model ? { model: obj.model } : {}),
          },
          realDir,
        ).catch(() => {}),
      )
    }

    // Start asynchronous run in the background
    startBackgroundRun({
      sdk,
      sessionID,
      prompt: obj.prompt as string,
      model: obj.model as string | undefined,
      directory: realDir,
    })
    lockedDir = undefined

    return HttpServerResponse.jsonUnsafe({ sessionID }, { status: 202 })
  }).pipe(
    Effect.catchCause((cause) => {
      if (lockedDir) {
        activeDirectories.delete(lockedDir)
        lockedDir = undefined
      }
      return Effect.logError("trigger endpoint error", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            { error: "Internal error" },
            { status: 500 },
          ),
        ),
      )
    }),
  )
}

export const triggerRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const configSvc = yield* Config.Service
    yield* router.add("POST", "/trigger", (request) => handleTrigger(request, configSvc))
  }),
)
