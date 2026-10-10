import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  url.searchParams.set("directory", directory)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-yukioshi-directory": directory,
      },
    }),
    context,
  )
}

beforeEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    if (list.status !== 200) {
      const err = await list.text()
      throw new Error(`list returned HTTP ${list.status}: ${err}`)
    }
    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    if (content.status !== 200) {
      const err = await content.text()
      throw new Error(`content returned HTTP ${content.status}: ${err}`)
    }
    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    if (status.status !== 200) {
      const err = await status.text()
      throw new Error(`status returned HTTP ${status.status}: ${err}`)
    }
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    let lastTextResponse: { status: number; body: string } | undefined
    const text = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findText, tmp.path, { pattern: "needle" })
          if (response.status !== 200) {
            const body = await response.text()
            lastTextResponse = { status: response.status, body }
            return undefined
          }
          const body = (await response.json()) as Array<{ line_number: number }>
          return Array.isArray(body) && body.some((item) => item.line_number === 1)
            ? { response, body }
            : undefined
        }),
        "text search index was not ready",
        "50 seconds",
      ),
    ).catch(async (err) => {
      if (lastTextResponse) {
        throw new Error(`findText timed out; last response HTTP ${lastTextResponse.status}: ${lastTextResponse.body}`)
      }
      throw err
    })

    expect(text.response.status).toBe(200)
    expect(text.body).toContainEqual(expect.objectContaining({ line_number: 1 }))

    const symbols = await request(FilePaths.findSymbol, tmp.path, { query: "hello" })
    if (symbols.status !== 200) {
      const body = await symbols.text()
      throw new Error(`findSymbol returned HTTP ${symbols.status}: ${body}`)
    }
    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])

    let lastFileResponse: { status: number; body: string } | undefined
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          if (response.status !== 200) {
            const bodyText = await response.text()
            lastFileResponse = { status: response.status, body: bodyText }
            return undefined
          }
          const body = (await response.json()) as string[]
          return Array.isArray(body) && body.some((item) => item.includes("hello.txt"))
            ? { response, body }
            : undefined
        }),
        "file search index was not ready",
        "50 seconds",
      ),
    ).catch(async (err) => {
      if (lastFileResponse) {
        throw new Error(`findFile timed out; last response HTTP ${lastFileResponse.status}: ${lastFileResponse.body}`)
      }
      throw err
    })

    expect(files.response.status).toBe(200)
    expect(files.body.some((item) => item.includes("hello.txt"))).toBe(true)
  }, 60_000)
})
