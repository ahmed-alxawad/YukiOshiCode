import { describe, expect, test } from "bun:test"
import { DesktopController, initialState, type DesktopState } from "../../src/renderer/app"
import type { KothoraDesktopBridge } from "../../src/renderer/global"

const bridge = (overrides: Partial<KothoraDesktopBridge> = {}): KothoraDesktopBridge => ({
  selectWorkspace: async () => ({ path: "/workspace", name: "workspace" }),
  listWorkspaceFiles: async () => [{ path: "src/app.ts", kind: "file" }],
  readWorkspaceFile: async (path) => `content:${path}`,
  listChanges: async () => [{ path: "src/app.ts", additions: 4, deletions: 2, status: "modified" }],
  readDiff: async ({ path }) => `diff:${path}`,
  startTask: async () => ({ taskId: "task-1" }),
  getTask: async ({ taskId }) => ({ taskId, status: "running" }),
  cancelTask: async () => {},
  ...overrides,
})

const setup = (overrides: Partial<KothoraDesktopBridge> = {}) => {
  const renders: DesktopState[] = []
  const controller = new DesktopController(bridge(overrides), (state) => renders.push(structuredClone(state)))
  return { controller, renders }
}

class ManualTimer {
  callbacks = new Map<number, () => void>()
  nextId = 1

  set = (callback: () => void) => {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id
  }

  clear = (handle: unknown) => {
    this.callbacks.delete(handle as number)
  }

  async runNext() {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error("No scheduled poll")
    this.callbacks.delete(entry[0])
    entry[1]()
    for (let index = 0; index < 6; index++) await Promise.resolve()
  }
}

describe("desktop renderer state", () => {
  test("selects a workspace and reloads its files", async () => {
    const selected: string[] = []
    const fake = bridge({
      selectWorkspace: async () => ({ path: "/workspace/project", name: "project" }),
    })
    const controller = new DesktopController(fake, (state) => selected.push(state.loadState))
    await controller.selectWorkspace()
    expect(controller.state.loadState).toBe("ready")
    expect(controller.state.files).toHaveLength(1)
    expect(selected).toContain("loading")
  })

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

  test("polls a started task and refreshes changes after completion", async () => {
    const timer = new ManualTimer()
    let statusCalls = 0
    let changeCalls = 0
    const fake = bridge({
      listChanges: async () => {
        changeCalls++
        return changeCalls > 1 ? [{ path: "done.ts", additions: 1, deletions: 0, status: "modified" }] : []
      },
      getTask: async ({ taskId }) => ({ taskId, status: ++statusCalls === 1 ? "running" : "complete" }),
    })
    const controller = new DesktopController(fake, () => {}, { timer, intervalMs: 1, maxAttempts: 3 })
    await controller.load()
    controller.setPrompt("Do work")
    await controller.startTask()
    expect(timer.callbacks.size).toBe(1)
    await timer.runNext()
    expect(controller.state.task?.status).toBe("running")
    expect(timer.callbacks.size).toBe(1)
    await timer.runNext()
    expect(controller.state.task?.status).toBe("complete")
    expect(controller.state.changes[0]?.path).toBe("done.ts")
    expect(timer.callbacks.size).toBe(0)
  })

  test("stops polling on cancel, disposal, errors, and the attempt limit", async () => {
    for (const action of ["cancel", "dispose"] as const) {
      const timer = new ManualTimer()
      const controller = new DesktopController(bridge(), () => {}, { timer })
      controller.setPrompt("Do work")
      await controller.startTask()
      if (action === "cancel") await controller.cancelTask()
      else controller.dispose()
      expect(timer.callbacks.size).toBe(0)
    }

    const errorTimer = new ManualTimer()
    const errored = new DesktopController(
      bridge({
        getTask: async () => {
          throw new Error("status unavailable")
        },
      }),
      () => {},
      { timer: errorTimer },
    )
    errored.setPrompt("Do work")
    await errored.startTask()
    await errorTimer.runNext()
    expect(errored.state).toMatchObject({ taskState: "error", error: "status unavailable" })
    expect(errorTimer.callbacks.size).toBe(0)

    const boundedTimer = new ManualTimer()
    const bounded = new DesktopController(bridge(), () => {}, { timer: boundedTimer, maxAttempts: 1 })
    bounded.setPrompt("Do work")
    await bounded.startTask()
    await boundedTimer.runNext()
    expect(bounded.state).toMatchObject({ taskState: "error", error: "Task status polling timed out" })
    expect(boundedTimer.callbacks.size).toBe(0)
  })
})
