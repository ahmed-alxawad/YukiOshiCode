import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@yukioshi/core/effect/layer-node"
import { CrossSpawnSpawner } from "@yukioshi/core/cross-spawn-spawner"
import { Global } from "@yukioshi/core/global"
import type { ConfigHooksV1 } from "@yukioshi/core/v1/config/hooks"
import { Hooks } from "@/hooks"
import * as HttpHook from "@/hooks/http"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([Hooks.node, CrossSpawnSpawner.node]), [])).effect

type Seen = { body: string; headers: Headers; url: string }

/** A local HTTP server that records every request it gets and answers with `respond`. */
const serve = (respond: (request: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: Seen[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        async fetch(request) {
          seen.push({ body: await request.text(), headers: request.headers, url: request.url })
          return respond(request)
        },
      })
      return { seen, url: `http://127.0.0.1:${server.port}`, server }
    }),
    ({ server }) => Effect.sync(() => void server.stop(true)),
  )

/** Runs with a temporary global config. Each test builds its own Config, so the global config is read fresh. */
const withGlobalConfig = (config: object) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const previous = Global.Path.config
      const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "yk-http-hook-global-"))
      await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(config))
      ;(Global.Path as { config: string }).config = dir
      return { previous, dir }
    }),
    ({ previous, dir }) =>
      Effect.promise(async () => {
        ;(Global.Path as { config: string }).config = previous
        await fs.rm(dir, { recursive: true, force: true })
      }),
  )

const http = (url: string, extra: Partial<HttpHook.Hook> = {}): HttpHook.Hook => ({ type: "http", url, ...extra })

/** The local test server is on loopback, so the user's global config has to allow it, as a real user would. */
const allowedLocally = (event: keyof ConfigHooksV1.Info, hook: HttpHook.Hook) =>
  withGlobalConfig({ hooks: { [event]: [{ ...hook, allowPrivateAddress: true }] } }).pipe(
    Effect.as({ ...hook, allowPrivateAddress: true }),
  )

const github = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"

describe("HTTP hooks", () => {
  it("POSTs the masked hook JSON with content-type application/json", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response(null, { status: 204 }))
      const hook = yield* allowedLocally("preToolUse", http(`${server.url}/hook`, { matcher: "bash" }))
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service

      const result = yield* hooks.run({
        hooks: { preToolUse: [hook] },
        event: "PreToolUse",
        payload: { session_id: "ses_http", tool_name: "bash", tool_input: { command: `curl -H ${github}` } },
        cwd,
        toolName: "bash",
      })

      expect(result).toEqual({ context: [], warnings: [], ran: 1 })
      expect(server.seen).toHaveLength(1)
      expect(new URL(server.seen[0]!.url).pathname).toBe("/hook")
      expect(server.seen[0]!.headers.get("content-type")).toBe("application/json")
      expect(server.seen[0]!.body).not.toContain(github)
      expect(JSON.parse(server.seen[0]!.body)).toEqual({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "ses_http",
        tool_name: "bash",
        tool_input: { command: expect.stringContaining("[REDACTED:") },
      })
    }))

  it("expands $NAME and ${NAME} in headers only for variables in allowedEnvVars", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response(null, { status: 204 }))
      process.env.YK_HTTP_HOOK_ALLOWED = "allowed-value-123"
      process.env.YK_HTTP_HOOK_OTHER = "other-secret-value-456"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.YK_HTTP_HOOK_ALLOWED
          delete process.env.YK_HTTP_HOOK_OTHER
        }),
      )
      const hook = yield* allowedLocally(
        "stop",
        http(server.url, {
          headers: {
            Authorization: "Bearer $YK_HTTP_HOOK_ALLOWED",
            "X-Braced": "${YK_HTTP_HOOK_ALLOWED}!",
            "X-Other": "[$YK_HTTP_HOOK_OTHER]",
          },
          allowedEnvVars: ["YK_HTTP_HOOK_ALLOWED"],
        }),
      )
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service

      const result = yield* hooks.run({ hooks: { stop: [hook] }, event: "Stop", payload: {}, cwd })

      expect(result.warnings).toEqual([])
      const headers = server.seen[0]!.headers
      expect(headers.get("authorization")).toBe("Bearer allowed-value-123")
      expect(headers.get("x-braced")).toBe("allowed-value-123!")
      expect(headers.get("x-other")).toBe("[]")
    }))

  it("a server that never answers times out without holding up the turn", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Promise<Response>(() => {}))
      const hook = yield* allowedLocally("preToolUse", http(server.url, { timeoutMs: 300 }))
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service

      const started = Date.now()
      const result = yield* hooks.run({
        hooks: { preToolUse: [hook] },
        event: "PreToolUse",
        payload: {},
        cwd,
        toolName: "bash",
      })

      expect(Date.now() - started).toBeLessThan(3_000)
      expect(server.seen).toHaveLength(1)
      expect(result.blocked).toBeUndefined()
      expect(result.warnings).toEqual([`PreToolUse HTTP hook to ${server.url} timed out`])
    }))

  it("refuses a private or loopback address by default, before connecting", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => Response.json({ decision: "block", reason: "reached" }))
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service

      const result = yield* hooks.run({
        hooks: { preToolUse: [http(server.url)] },
        event: "PreToolUse",
        payload: {},
        cwd,
        toolName: "bash",
      })

      expect(server.seen).toHaveLength(0)
      expect(result.blocked).toBeUndefined()
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("private or local network address")
    }))

  it("allowPrivateAddress outside the global config (a project's hook) is not honoured", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response(null, { status: 204 }))
      // The global config allows a different URL; the project's own opt-in for this one does not count.
      yield* withGlobalConfig({
        hooks: { preToolUse: [{ type: "http", url: "http://127.0.0.1:1/other", allowPrivateAddress: true }] },
      })
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service

      const result = yield* hooks.run({
        hooks: { preToolUse: [http(server.url, { allowPrivateAddress: true })] },
        event: "PreToolUse",
        payload: {},
        cwd,
        toolName: "bash",
      })

      expect(server.seen).toHaveLength(0)
      expect(result.warnings[0]).toContain("private or local network address")
    }))

  it("classifies private, loopback, link-local and mapped addresses", () =>
    Effect.sync(() => {
      for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1"])
        expect(HttpHook.isPrivateAddress(address)).toBe(true)
      for (const address of ["::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "ff02::1"])
        expect(HttpHook.isPrivateAddress(address)).toBe(true)
      for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
        expect(HttpHook.isPrivateAddress(address)).toBe(false)
    }))

  it("masks secrets from the URL and headers in warnings and block reasons", () =>
    Effect.gen(function* () {
      process.env.YK_HTTP_HOOK_TOKEN = "header-token-0123456789"
      yield* Effect.addFinalizer(() => Effect.sync(() => void delete process.env.YK_HTTP_HOOK_TOKEN))
      const server = yield* serve((request) =>
        new URL(request.url).pathname.startsWith("/fail")
          ? new Response("nope", { status: 500 })
          : Response.json({
              decision: "block",
              reason: `refused for ${request.headers.get("x-token")}`,
            }),
      )
      const headers = { "X-Token": "$YK_HTTP_HOOK_TOKEN" }
      const failing = http(`${server.url}/fail/T000/B000/url-path-secret?token=query-secret`, {
        headers,
        allowedEnvVars: ["YK_HTTP_HOOK_TOKEN"],
      })
      const blocking = http(`${server.url}/block`, { headers, allowedEnvVars: ["YK_HTTP_HOOK_TOKEN"] })
      yield* withGlobalConfig({
        hooks: {
          preToolUse: [failing, blocking].map((hook) => ({ ...hook, allowPrivateAddress: true })),
        },
      })
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service

      const result = yield* hooks.run({
        hooks: { preToolUse: [failing, blocking].map((hook) => ({ ...hook, allowPrivateAddress: true })) },
        event: "PreToolUse",
        payload: {},
        cwd,
        toolName: "bash",
      })

      expect(server.seen).toHaveLength(2)
      expect(result.warnings).toEqual([`PreToolUse HTTP hook to ${server.url} failed: returned status 500`])
      expect(result.blocked).toBeDefined()
      const shown = [...result.warnings, result.blocked!].join("\n")
      for (const secret of ["url-path-secret", "query-secret", "header-token-0123456789"])
        expect(shown).not.toContain(secret)
    }))

  it("blocks with a JSON decision in a 2xx response, like a command hook's output", () =>
    Effect.gen(function* () {
      const server = yield* serve((request) => {
        const path = new URL(request.url).pathname
        if (path === "/deny")
          return Response.json({
            hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "denied by policy" },
          })
        if (path === "/forbidden") return Response.json({ decision: "block", reason: "ignored" }, { status: 403 })
        return Response.json({ decision: "block", reason: "no deletes" })
      })
      const cwd = yield* tmpdirScoped()
      yield* withGlobalConfig({
        hooks: {
          preToolUse: ["/block", "/deny", "/forbidden"].map((p) => ({
            type: "http",
            url: `${server.url}${p}`,
            allowPrivateAddress: true,
          })),
        },
      })
      const hooks = yield* Hooks.Service
      const run = (p: string) =>
        hooks.run({
          hooks: { preToolUse: [{ ...http(`${server.url}${p}`), allowPrivateAddress: true }] },
          event: "PreToolUse",
          payload: {},
          cwd,
          toolName: "bash",
        })

      expect((yield* run("/block")).blocked).toBe("no deletes")
      expect((yield* run("/deny")).blocked).toBe("denied by policy")
      // A non-2xx status is a failed hook, never a block (as a command hook exiting with code 1).
      const forbidden = yield* run("/forbidden")
      expect(forbidden.blocked).toBeUndefined()
      expect(forbidden.warnings).toEqual([`PreToolUse HTTP hook to ${server.url} failed: returned status 403`])
    }))

  it("adds a plain-text response to UserPromptSubmit as context", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response("branch: main"))
      const hook = yield* allowedLocally("userPromptSubmit", http(server.url))
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service

      const result = yield* hooks.run({
        hooks: { userPromptSubmit: [hook] },
        event: "UserPromptSubmit",
        payload: {},
        cwd,
      })

      expect(result.context).toEqual(["branch: main"])
    }))

  it("refuses a response larger than 64 KiB", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => new Response("x".repeat(HttpHook.MAX_RESPONSE_BYTES + 1)))
      const hook = yield* allowedLocally("userPromptSubmit", http(server.url))
      const cwd = yield* tmpdirScoped()
      const hooks = yield* Hooks.Service

      const result = yield* hooks.run({
        hooks: { userPromptSubmit: [hook] },
        event: "UserPromptSubmit",
        payload: {},
        cwd,
      })

      expect(result.context).toEqual([])
      expect(result.warnings[0]).toContain("larger than 65536 bytes")
    }))
})
