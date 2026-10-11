import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { fetchWithTimeout } from "../../src/util/fetch-timeout"

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
})
