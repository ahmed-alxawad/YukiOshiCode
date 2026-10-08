import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { config, globalConfig, requestText, runtimeEnv, waitFor } from "./helpers"

const fromReviewer = (hit: { body: Record<string, unknown> }) => requestText(hit.body).includes("<action>")
const fromAgent = (hit: { body: Record<string, unknown> }) => !fromReviewer(hit)

function auditEntries(home: string) {
  const dir = path.join(`${home}-state`, "yukioshi", "audit")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("authenticated trigger on yukioshi serve", () => {
  cliIt.live(
    "off by default returns 404",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const token = "x".repeat(32)
        const server = yield* opencode.serve({
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
            TEST_TRIGGER_TOKEN: token,
          },
        })

        const res = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ prompt: "do something", directory: home }),
          }),
        )
        expect(res.status).toBe(404)
      }),
    60_000,
  )

  cliIt.live(
    "a project config cannot enable triggers",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const token = "y".repeat(32)
        // Project tries to enable triggers in its own config
        fs.writeFileSync(
          path.join(home, "yukioshi.json"),
          JSON.stringify({
            triggers: {
              enabled: true,
              token_env: "TEST_TRIGGER_TOKEN",
              directories: [home],
            },
          }),
        )

        const server = yield* opencode.serve({
          cwd: home,
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
            TEST_TRIGGER_TOKEN: token,
            YUKIOSHI_DISABLE_PROJECT_CONFIG: "0",
          },
        })

        const res = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ prompt: "try trigger", directory: home }),
          }),
        )
        expect(res.status).toBe(404)
      }),
    60_000,
  )

  cliIt.live(
    "refuses to enable when token is shorter than 32 characters",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const shortToken = "only-20-chars-here!!"
        globalConfig(home, {
          triggers: {
            enabled: true,
            token_env: "SHORT_TRIGGER_TOKEN",
            directories: [home],
          },
        })

        const server = yield* opencode.serve({
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
            SHORT_TRIGGER_TOKEN: shortToken,
          },
        })

        const res = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${shortToken}`,
            },
            body: JSON.stringify({ prompt: "test", directory: home }),
          }),
        )
        expect(res.status).toBe(404)
      }),
    60_000,
  )

  cliIt.live(
    "wrong token returns 401",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const validToken = "t".repeat(32)
        globalConfig(home, {
          triggers: {
            enabled: true,
            token_env: "VALID_TRIGGER_TOKEN",
            directories: [home],
          },
        })

        const server = yield* opencode.serve({
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
            VALID_TRIGGER_TOKEN: validToken,
            YUKIOSHI_SERVER_PASSWORD: "server-secret-password-123",
          },
        })

        // 1. Wrong bearer token
        const resBadBearer = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer wrong-token-12345678901234567890",
            },
            body: JSON.stringify({ prompt: "test", directory: home }),
          }),
        )
        expect(resBadBearer.status).toBe(401)

        // 2. Server password (Basic auth) does not open /trigger
        const resBasic = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Basic ${Buffer.from("opencode:server-secret-password-123").toString("base64")}`,
            },
            body: JSON.stringify({ prompt: "test", directory: home }),
          }),
        )
        expect(resBasic.status).toBe(401)

        // 3. No auth header
        const resNoAuth = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: "test", directory: home }),
          }),
        )
        expect(resNoAuth.status).toBe(401)
      }),
    60_000,
  )

  cliIt.live(
    "other directory returns 403",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const token = "d".repeat(32)
        const allowedDir = path.join(home, "allowed-project")
        fs.mkdirSync(allowedDir, { recursive: true })

        globalConfig(home, {
          triggers: {
            enabled: true,
            token_env: "DIR_TRIGGER_TOKEN",
            directories: [allowedDir],
          },
        })

        const server = yield* opencode.serve({
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
            DIR_TRIGGER_TOKEN: token,
          },
        })

        // Request targeting home (which is not allowedDir)
        const res = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ prompt: "test", directory: home }),
          }),
        )
        expect(res.status).toBe(403)
      }),
    60_000,
  )

  cliIt.live(
    "bad body returns 400",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const token = "b".repeat(32)
        globalConfig(home, {
          triggers: {
            enabled: true,
            token_env: "BODY_TRIGGER_TOKEN",
            directories: [home],
          },
        })

        const server = yield* opencode.serve({
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url),
            BODY_TRIGGER_TOKEN: token,
          },
        })

        // Unknown field
        const resUnknown = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ prompt: "test", directory: home, unknownField: true }),
          }),
        )
        expect(resUnknown.status).toBe(400)

        // Missing prompt
        const resMissingPrompt = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ directory: home }),
          }),
        )
        expect(resMissingPrompt.status).toBe(400)

        // Body exceeding 64 KB
        const bigPrompt = "x".repeat(70_000)
        const resTooBig = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ prompt: bigPrompt, directory: home }),
          }),
        )
        expect(resTooBig.status).toBe(413)
      }),
    60_000,
  )

  cliIt.live(
    "a good request creates a session, runs in review mode, consults reviewer, writes audit, and busy returns 409",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const token = "g".repeat(32)
        const targetFile = path.join(home, "from-trigger.txt")

        globalConfig(home, {
          triggers: {
            enabled: true,
            token_env: "GOOD_TRIGGER_TOKEN",
            directories: [home],
            mode: "review",
          },
          audit: {
            enabled: true,
          },
        })

        yield* llm.pushMatch(
          fromAgent,
          reply().tool("bash", { command: `touch ${targetFile}`, description: "create trigger file" }),
          reply().text("finished task").stop(),
        )
        yield* llm.pushMatch(
          fromReviewer,
          reply().text("ALLOW: creates the requested file").stop(),
        )

        const server = yield* opencode.serve({
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { model: "test/test-model" }),
            GOOD_TRIGGER_TOKEN: token,
          },
        })

        // Send first valid trigger request
        const res = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ prompt: "create from-trigger.txt", directory: home }),
          }),
        )

        expect(res.status).toBe(202)
        const data = (yield* Effect.promise(() => res.json())) as { sessionID: string }
        expect(typeof data.sessionID).toBe("string")
        expect(data.sessionID.length).toBeGreaterThan(0)

        // Immediate second request to same directory should be 409 (busy)
        const resBusy = yield* Effect.promise(() =>
          fetch(`${server.url}/trigger`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ prompt: "second prompt", directory: home }),
          }),
        )
        expect(resBusy.status).toBe(409)

        // Wait for file creation by background run
        yield* Effect.promise(() =>
          waitFor(() => fs.existsSync(targetFile), "targetFile was not created by trigger run", 20_000),
        )
        expect(fs.existsSync(targetFile)).toBe(true)

        // Check that the reviewer was consulted
        const inputs = yield* llm.inputs
        const reviews = inputs.filter((input) => requestText(input).includes("<action>"))
        expect(reviews.length).toBeGreaterThan(0)
        expect(requestText(reviews[0]!)).toContain("create from-trigger.txt")

        // Check audit log
        yield* Effect.promise(() =>
          waitFor(
            () => auditEntries(home).some((e) => e.event === "trigger" && e.session === data.sessionID),
            "audit log entry for trigger was not written",
            5_000,
          ),
        )
        const logs = auditEntries(home)
        const triggerEntry = logs.find((e) => e.event === "trigger" && e.session === data.sessionID)
        expect(triggerEntry).toBeDefined()
        expect(triggerEntry?.directory).toBe(home)
        expect(triggerEntry?.mode).toBe("review")
      }),
    90_000,
  )
})
