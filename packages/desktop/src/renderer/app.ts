import type { ChangedFile, KothoraDesktopBridge, TaskRun, WorkspaceFile } from "./global"
import { selectLocale, translate, type Locale } from "./i18n"

export type LoadState = "idle" | "loading" | "ready" | "error"
export type ReviewMode = "file" | "diff"

export interface DesktopState {
  loadState: LoadState
  files: WorkspaceFile[]
  changes: ChangedFile[]
  selectedPath?: string
  content: string
  contentState: LoadState
  mode: ReviewMode
  prompt: string
  task?: TaskRun
  taskState: LoadState
  error?: string
}

export const initialState = (): DesktopState => ({
  loadState: "idle",
  files: [],
  changes: [],
  content: "",
  contentState: "idle",
  mode: "file",
  prompt: "",
  taskState: "idle",
})

export interface PollTimer {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export interface PollOptions {
  intervalMs?: number
  maxAttempts?: number
  timer?: PollTimer
}

const defaultTimer: PollTimer = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const message = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong")

export class DesktopController {
  readonly state = initialState()
  readonly #pollIntervalMs: number
  readonly #maxPollAttempts: number
  readonly #timer: PollTimer
  #pollHandle?: unknown
  #pollGeneration = 0
  #pollAttempts = 0

  constructor(
    private readonly bridge: KothoraDesktopBridge,
    private readonly onChange: (state: DesktopState) => void,
    options: PollOptions = {},
  ) {
    this.#pollIntervalMs = options.intervalMs ?? 1_000
    this.#maxPollAttempts = options.maxAttempts ?? 3_600
    this.#timer = options.timer ?? defaultTimer
  }

  private emit() {
    this.onChange(this.state)
  }

  async selectWorkspace() {
    this.state.error = undefined
    this.state.loadState = "loading"
    this.emit()
    try {
      const selected = await this.bridge.selectWorkspace()
      if (selected === null) {
        this.state.loadState = "idle"
        this.emit()
        return
      }
      this.state.selectedPath = undefined
      this.state.content = ""
      this.state.contentState = "idle"
      await this.load()
    } catch (error) {
      this.state.loadState = "error"
      this.state.error = message(error)
      this.emit()
    }
  }

  async load() {
    this.state.loadState = "loading"
    this.state.error = undefined
    this.emit()
    try {
      const [files, changes] = await Promise.all([this.bridge.listWorkspaceFiles(), this.bridge.listChanges()])
      this.state.files = files
      this.state.changes = changes
      this.state.loadState = "ready"
    } catch (error) {
      this.state.loadState = "error"
      this.state.error = message(error)
    }
    this.emit()
  }

  async selectFile(path: string) {
    this.state.selectedPath = path
    this.state.mode = "file"
    await this.loadContent(() => this.bridge.readWorkspaceFile(path))
  }

  async selectDiff(path: string) {
    this.state.selectedPath = path
    this.state.mode = "diff"
    await this.loadContent(() => this.bridge.readDiff({ source: "git", path }))
  }

  private async loadContent(read: () => Promise<string>) {
    this.state.contentState = "loading"
    this.state.error = undefined
    this.emit()
    try {
      this.state.content = await read()
      this.state.contentState = "ready"
    } catch (error) {
      this.state.content = ""
      this.state.contentState = "error"
      this.state.error = message(error)
    }
    this.emit()
  }

  setPrompt(prompt: string) {
    this.state.prompt = prompt
    this.emit()
  }

  async startTask() {
    const prompt = this.state.prompt.trim()
    if (!prompt || this.state.task?.status === "running") return
    this.state.taskState = "loading"
    this.state.error = undefined
    this.emit()
    try {
      const { taskId } = await this.bridge.startTask({ prompt })
      this.state.task = { id: taskId, status: "running" }
      this.state.taskState = "ready"
      this.startPolling(taskId)
    } catch (error) {
      this.state.taskState = "error"
      this.state.error = message(error)
    }
    this.emit()
  }

  async cancelTask() {
    if (!this.state.task || this.state.task.status !== "running") return
    this.state.taskState = "loading"
    this.stopPolling()
    this.emit()
    try {
      await this.bridge.cancelTask({ taskId: this.state.task.id })
      this.state.task = { ...this.state.task, status: "cancelled" }
      this.state.taskState = "ready"
    } catch (error) {
      this.state.taskState = "error"
      this.state.error = message(error)
    }
    this.emit()
  }

  dispose() {
    this.stopPolling()
  }

  private startPolling(taskId: string) {
    this.stopPolling()
    const generation = this.#pollGeneration
    this.#pollAttempts = 0
    const schedule = () => {
      if (generation !== this.#pollGeneration) return
      if (this.#pollAttempts >= this.#maxPollAttempts) {
        this.state.taskState = "error"
        this.state.error = "Task status polling timed out"
        this.emit()
        return
      }
      this.#pollHandle = this.#timer.set(() => void poll(), this.#pollIntervalMs)
    }
    const poll = async () => {
      this.#pollHandle = undefined
      this.#pollAttempts += 1
      try {
        const task = await this.bridge.getTask({ taskId })
        if (generation !== this.#pollGeneration) return
        if (task.taskId !== taskId) throw new Error("Task status did not match the active task")
        this.state.task = { id: task.taskId, status: task.status }
        this.state.taskState = "ready"
        this.emit()
        if (task.status === "running") schedule()
        else {
          this.stopPolling()
          await this.load()
        }
      } catch (error) {
        if (generation !== this.#pollGeneration) return
        this.stopPolling()
        this.state.taskState = "error"
        this.state.error = message(error)
        this.emit()
      }
    }
    schedule()
  }

  private stopPolling() {
    this.#pollGeneration += 1
    if (this.#pollHandle !== undefined) this.#timer.clear(this.#pollHandle)
    this.#pollHandle = undefined
  }
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

const text = (tag: keyof HTMLElementTagNameMap, value: string, className?: string) => {
  const node = element(tag, className)
  node.textContent = value
  return node
}

function renderList<T>(host: HTMLElement, items: T[], empty: string, render: (item: T) => HTMLElement) {
  host.replaceChildren()
  if (items.length === 0) host.append(text("p", empty, "empty"))
  else host.append(...items.map(render))
}

export function mountDesktopApp(
  root: HTMLElement,
  bridge: KothoraDesktopBridge,
  locale: Locale = selectLocale(globalThis.navigator?.language),
) {
  const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
    translate(locale, key, values)
  const taskStatusText = (task: TaskRun) => {
    if (task.status === "complete") return t("taskComplete")
    if (task.status === "cancelled") return t("taskCancelled")
    if (task.status === "failed") return t("taskFailed")
    return t("taskRunning")
  }
  root.lang = locale
  root.className = "desktop-app"
  const taskForm = element("form", "task-form")
  const taskLabel = text("label", t("taskPromptLabel"), "sr-only") as HTMLLabelElement
  taskLabel.htmlFor = "task-prompt"
  const prompt = element("textarea")
  prompt.id = "task-prompt"
  prompt.rows = 2
  prompt.placeholder = t("taskPromptPlaceholder")
  const start = element("button", "primary")
  start.type = "submit"
  start.textContent = t("startTask")
  const cancel = element("button")
  cancel.type = "button"
  cancel.textContent = t("cancelTask")
  taskForm.append(taskLabel, prompt, start, cancel)

  const status = element("div", "status")
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  const chooseWorkspace = element("button")
  chooseWorkspace.type = "button"
  chooseWorkspace.textContent = t("selectWorkspace")
  const fileList = element("nav", "file-list")
  fileList.setAttribute("aria-label", t("workspaceFilesLabel"))
  const changeList = element("nav", "change-list")
  changeList.setAttribute("aria-label", t("changedFilesLabel"))
  const viewerTitle = text("h2", t("selectFileHeading"))
  const viewer = element("pre", "viewer")
  viewer.tabIndex = 0
  const sidebar = element("aside", "sidebar")
  sidebar.append(text("h2", t("workspaceHeading")), fileList, text("h2", t("changesHeading")), changeList)
  const main = element("main", "review")
  main.append(viewerTitle, viewer)
  const header = element("header")
  header.append(text("h1", t("appName")), chooseWorkspace, taskForm, status)
  root.replaceChildren(header, sidebar, main)

  const render = (state: DesktopState) => {
    prompt.value = state.prompt
    start.disabled = state.taskState === "loading" || state.task?.status === "running" || !state.prompt.trim()
    cancel.hidden = state.task?.status !== "running"
    cancel.disabled = state.taskState === "loading"
    status.className = `status${state.error ? " error" : ""}`
    status.textContent = state.error
      ? t("errorStatus", { message: state.error })
      : state.loadState === "loading"
        ? t("loadingWorkspace")
        : state.task?.status === "running"
          ? t("taskRunning")
          : state.task
            ? taskStatusText(state.task)
            : t("ready")

    renderList(
      fileList,
      state.files.filter((entry) => entry.kind === "file"),
      t("noWorkspaceFiles"),
      (entry) => {
        const button = element("button", "list-item")
        button.type = "button"
        button.textContent = entry.path
        button.title = entry.path
        button.setAttribute(
          "aria-current",
          state.mode === "file" && state.selectedPath === entry.path ? "true" : "false",
        )
        button.addEventListener("click", () => void controller.selectFile(entry.path))
        return button
      },
    )
    renderList(changeList, state.changes, t("noChangedFiles"), (change) => {
      const button = element("button", "change-item")
      button.type = "button"
      const path = text("span", change.path, "path")
      const count = text("span", `+${change.additions} −${change.deletions}`, "count")
      count.setAttribute("aria-label", t("changeCount", { additions: change.additions, deletions: change.deletions }))
      button.append(path, count)
      button.setAttribute(
        "aria-current",
        state.mode === "diff" && state.selectedPath === change.path ? "true" : "false",
      )
      button.addEventListener("click", () => void controller.selectDiff(change.path))
      return button
    })

    viewerTitle.textContent = state.selectedPath
      ? t(state.mode === "diff" ? "diffHeading" : "fileHeading", { path: state.selectedPath })
      : t("selectFileHeading")
    viewer.className = `viewer ${state.mode}`
    viewer.setAttribute("aria-busy", String(state.contentState === "loading"))
    viewer.textContent =
      state.contentState === "loading"
        ? t("loadingContent")
        : state.contentState === "error"
          ? t("contentLoadError")
          : state.selectedPath
            ? state.content || t("emptyFile")
            : t("selectReviewItem")
  }

  const controller = new DesktopController(bridge, render)
  prompt.addEventListener("input", () => controller.setPrompt(prompt.value))
  taskForm.addEventListener("submit", (event) => {
    event.preventDefault()
    void controller.startTask()
  })
  cancel.addEventListener("click", () => void controller.cancelTask())
  chooseWorkspace.addEventListener("click", () => void controller.selectWorkspace())
  render(controller.state)
  void controller.load()
  return controller
}
