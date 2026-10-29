import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  DesktopDiffQuery,
  DesktopPaths,
  DesktopTaskPayload,
} from "../../src/server/routes/instance/httpapi/groups/desktop"

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }))

describe("desktop HttpApi contract", () => {
  test("exposes the fixed desktop task lifecycle paths", () => {
    expect(DesktopPaths).toEqual({
      changes: "/desktop/changes",
      diff: "/desktop/diff",
      tasks: "/desktop/tasks",
      task: "/desktop/tasks/:id",
      cancel: "/desktop/tasks/:id/cancel",
    })
  })

  test("accepts bounded prompts and rejects malformed task payloads", async () => {
    await expect(decode(DesktopTaskPayload, { prompt: "Fix the failing test" })).resolves.toEqual({
      prompt: "Fix the failing test",
    })
    await expect(decode(DesktopTaskPayload, { prompt: "   " })).rejects.toBeDefined()
    await expect(decode(DesktopTaskPayload, { prompt: "x".repeat(100_001) })).rejects.toBeDefined()
    await expect(decode(DesktopTaskPayload, { prompt: "ok", directory: "/tmp/escape" })).rejects.toBeDefined()
    await expect(decode(DesktopTaskPayload, { prompt: 42 })).rejects.toBeDefined()
  })

  test("only accepts exact relative paths and known diff sources", async () => {
    await expect(decode(DesktopDiffQuery, { path: "src/index.ts", source: "git" })).resolves.toEqual({
      path: "src/index.ts",
      source: "git",
    })
    await expect(decode(DesktopDiffQuery, { source: "session" })).resolves.toEqual({ source: "session" })

    for (const path of ["/etc/passwd", "../secret", "src/../../secret", "src\\..\\secret", ""]) {
      await expect(decode(DesktopDiffQuery, { path })).rejects.toBeDefined()
    }
    await expect(decode(DesktopDiffQuery, { source: "filesystem" })).rejects.toBeDefined()
    await expect(decode(DesktopDiffQuery, { directory: "/tmp/escape" })).rejects.toBeDefined()
  })
})

