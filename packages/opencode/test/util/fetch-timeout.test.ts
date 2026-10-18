import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import net from "node:net"
import path from "path"
import { fetchWithTimeout } from "../../src/util/fetch-timeout"
import { tmpdir } from "../fixture/fixture"

const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")

function createStalledTcpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

// The fetch itself gives up after 1 s; the rest is CLI start-up, which takes much longer on loaded Windows runners.
const LIMIT_MS = process.platform === "win32" ? 40_000 : 8_000

async function runCli(home: string, args: string[], envOverrides: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", cliEntry, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      YUKIOSHI_TEST_HOME: home,
      YUKIOSHI_PURE: "1",
      YUKIOSHI_DISABLE_AUTOUPDATE: "1",
      YUKIOSHI_DISABLE_AUTOCOMPACT: "1",
      YUKIOSHI_DISABLE_MODELS_FETCH: "1",
      YUKIOSHI_FETCH_TIMEOUT_MS: "1000",
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) =>
    setTimeout(() => resolve({ timedOut: true }), LIMIT_MS),
  )

  const executionPromise = Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr, timedOut: false }))

  const winner = await Promise.race([executionPromise, timeoutPromise])
  if ("timedOut" in winner && winner.timedOut) {
    proc.kill()
    throw new Error("CLI process timed out (request was unbounded)")
  }
  return winner as { exitCode: number; stdout: string; stderr: string }
}

describe("fetchWithTimeout", () => {
  test("gives up on a server that never answers and names only the host", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      const started = Date.now()
      const error = await fetchWithTimeout(`http://127.0.0.1:${server.port}/file.zip?token=secret`, {}, 300).catch(
        (e) => e as Error,
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(`127.0.0.1:${server.port}`)
      expect((error as Error).message).not.toContain("secret")
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      server.stop(true)
    }
  })

  test("gives up on a body that stalls part way through", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("partial"))
            },
          }),
        ),
    })
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${server.port}/`, {}, 300)
      expect(response.ok).toBe(true)
      const error = await response.arrayBuffer().catch((e) => e as Error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("No response from")
    } finally {
      server.stop(true)
    }
  })

  test("passes a normal response through and honours the caller's abort signal", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("hello") })
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${server.port}/`, {}, 5_000)
      expect(await response.text()).toBe("hello")
      const controller = new AbortController()
      controller.abort()
      await expect(fetchWithTimeout(`http://127.0.0.1:${server.port}/`, { signal: controller.signal })).rejects.toBeDefined()
    } finally {
      server.stop(true)
    }
  })

  test.each(["lsp/server.ts", "cli/cmd/mcp.ts", "cli/cmd/import.ts"])("%s makes no unbounded fetch call", async (file) => {
    const source = await fs.readFile(path.join(import.meta.dir, "../../src", file), "utf8")
    expect(source.match(/(?<![\w.])fetch\(/g) ?? []).toEqual([])
  })

  test("MCP debug times out against a non-responsive TCP server and names host without leaking query strings", async () => {
    const server = await createStalledTcpServer()
    await using tmp = await tmpdir()
    try {
      const configDir = path.join(tmp.path, ".config", "yukioshi")
      await fs.mkdir(configDir, { recursive: true })
      await Bun.write(
        path.join(configDir, "yukioshi.json"),
        JSON.stringify({
          mcp: {
            "stalled-remote": {
              type: "remote",
              url: `http://127.0.0.1:${server.port}/mcp?token=SUPER_SECRET_TOKEN&apiKey=PRIVATE_KEY`,
            },
          },
        }),
      )

      const started = Date.now()
      const { stdout, stderr } = await runCli(tmp.path, ["mcp", "debug", "stalled-remote"])
      const elapsed = Date.now() - started

      expect(elapsed).toBeLessThan(LIMIT_MS)
      expect(stdout).toContain(`No response from 127.0.0.1:${server.port}`)
      expect(stdout).toContain("the request was stopped")

      const errorLines = stdout
        .split("\n")
        .filter((line) => line.includes("Error") || line.includes("Connection failed"))
      expect(errorLines.length).toBeGreaterThan(0)
      for (const line of errorLines) {
        expect(line).not.toContain("SUPER_SECRET_TOKEN")
        expect(line).not.toContain("PRIVATE_KEY")
        expect(line).not.toContain("apiKey=")
      }
    } finally {
      await server.close()
    }
  }, LIMIT_MS + 7_000)

  test("yukioshi import <url> times out against a non-responsive TCP server and names host without leaking query string", async () => {
    const server = await createStalledTcpServer()
    await using tmp = await tmpdir()
    try {
      const configDir = path.join(tmp.path, ".config", "yukioshi")
      await fs.mkdir(configDir, { recursive: true })
      await Bun.write(
        path.join(configDir, "yukioshi.json"),
        JSON.stringify({
          enterprise: {
            url: `http://127.0.0.1:${server.port}`,
          },
        }),
      )

      const started = Date.now()
      const { exitCode, stderr } = await runCli(tmp.path, [
        "import",
        `http://127.0.0.1:${server.port}/share/test-slug?token=SUPER_SECRET_TOKEN&sensitive=true`,
      ])
      const elapsed = Date.now() - started

      expect(exitCode).not.toBe(0)
      expect(elapsed).toBeLessThan(LIMIT_MS)
      expect(stderr).toContain(`Could not reach 127.0.0.1:${server.port}`)
      expect(stderr).toContain(`No response from 127.0.0.1:${server.port}`)
      expect(stderr).toContain("the request was stopped")
      expect(stderr).not.toContain("SUPER_SECRET_TOKEN")
      expect(stderr).not.toContain("sensitive=true")
    } finally {
      await server.close()
    }
  }, LIMIT_MS + 7_000)
})

describe("YUKIOSHI_FETCH_TIMEOUT_MS", () => {
  test.each(["abc", "0", "-5"])("the value %p is ignored and the default limit applies", async (value) => {
    const previous = process.env.YUKIOSHI_FETCH_TIMEOUT_MS
    process.env.YUKIOSHI_FETCH_TIMEOUT_MS = value
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(300)
        return new Response("ok")
      },
    })
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${server.port}/`)
      expect(await response.text()).toBe("ok")
    } finally {
      server.stop(true)
      if (previous === undefined) delete process.env.YUKIOSHI_FETCH_TIMEOUT_MS
      else process.env.YUKIOSHI_FETCH_TIMEOUT_MS = previous
    }
  })
})
