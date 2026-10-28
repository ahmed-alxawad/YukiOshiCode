import { describe, expect, test } from "bun:test"
import { DesktopController, initialState, type DesktopState } from "../../src/renderer/app"
import type { KothoraDesktopBridge } from "../../src/renderer/global"

const bridge = (overrides: Partial<KothoraDesktopBridge> = {}): KothoraDesktopBridge => ({
  listWorkspaceFiles: async () => [{ path: "src/app.ts", kind: "file" }],
  readWorkspaceFile: async (path) => `content:${path}`,
  listChanges: async () => [{ path: "src/app.ts", additions: 4, deletions: 2, status: "modified" }],
  readDiff: async ({ path }) => `diff:${path}`,
  startTask: async () => ({ taskId: "task-1" }),
  cancelTask: async () => {},
  ...overrides,
})

const setup = (overrides: Partial<KothoraDesktopBridge> = {}) => {
  const renders: DesktopState[] = []
  const controller = new DesktopController(bridge(overrides), (state) => renders.push(structuredClone(state)))
  return { controller, renders }
}

describe("desktop renderer state", () => {
  test("starts with safe empty states", () => {
    expect(initialState()).toEqual({
      loadState: "idle",
      files: [],
      changes: [],
      content: "",
      contentState: "idle",
      mode: "file",
      prompt: "",
      taskState: "idle",
    })
  })

  test("loads workspace files and changes", async () => {
    const { controller, renders } = setup()
    await controller.load()
    expect(renders[0]?.loadState).toBe("loading")
    expect(controller.state.loadState).toBe("ready")
    expect(controller.state.files[0]?.path).toBe("src/app.ts")
    expect(controller.state.changes[0]).toMatchObject({ additions: 4, deletions: 2 })
  })

  test("selects file content and unified diff independently", async () => {
    const { controller } = setup()
    await controller.selectFile("src/app.ts")
    expect(controller.state).toMatchObject({ mode: "file", content: "content:src/app.ts" })
    await controller.selectDiff("src/app.ts")
    expect(controller.state).toMatchObject({ mode: "diff", content: "diff:src/app.ts" })
  })

  test("exposes loading and error states", async () => {
    let resolve!: (value: string) => void
    const { controller, renders } = setup({
      readWorkspaceFile: () => new Promise((done) => (resolve = done)),
      readDiff: async () => {
        throw new Error("diff unavailable")
      },
    })
    const pending = controller.selectFile("slow.ts")
    expect(renders.at(-1)?.contentState).toBe("loading")
    resolve("done")
    await pending
    await controller.selectDiff("bad.ts")
    expect(controller.state).toMatchObject({ contentState: "error", error: "diff unavailable" })
  })

  test("starts and cancels a task while preventing blank prompts", async () => {
    let starts = 0
    let cancelled = ""
    const { controller } = setup({
      startTask: async () => {
        starts++
        return { taskId: "run-7" }
      },
      cancelTask: async ({ taskId }) => {
        cancelled = taskId
      },
    })
    await controller.startTask()
    expect(starts).toBe(0)
    controller.setPrompt("  Fix the parser  ")
    await controller.startTask()
    expect(controller.state.task).toEqual({ id: "run-7", status: "running" })
    await controller.cancelTask()
    expect(cancelled).toBe("run-7")
    expect(controller.state.task?.status).toBe("cancelled")
  })

  test("retains untrusted bridge strings as data", async () => {
    const payload = "<img src=x onerror=alert(1)>"
    const { controller } = setup({ readWorkspaceFile: async () => payload })
    await controller.selectFile("unsafe.txt")
    expect(controller.state.content).toBe(payload)
  })
})
