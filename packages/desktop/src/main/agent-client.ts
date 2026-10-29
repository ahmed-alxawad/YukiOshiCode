import type {
  CancelTaskInput,
  ChangeSummary,
  GetTaskInput,
  ReadDiffInput,
  StartedTask,
  StartTaskInput,
  TaskDetails,
  TaskStatus,
} from "./contracts"

export interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type FetchAdapter = (url: string, init?: RequestInit) => Promise<FetchResponse>

const desktopUsername = "kothora-desktop"
const validDesktopToken = /^[A-Za-z0-9_-]{43,128}$/

const assertLoopback = (baseUrl: string) => {
  const url = new URL(baseUrl)
  const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]"])
  if (
    url.protocol !== "http:" ||
    !loopbackNames.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Agent core must use an uncredentialed loopback HTTP endpoint")
  }
  return url
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const taskStatuses = new Set<TaskStatus>(["running", "complete", "failed", "cancelled"])
const validTaskId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)

export class AgentCoreClient {
  readonly #baseUrl: URL
  readonly #authorization: string

  constructor(
    baseUrl: string,
    token: string,
    private readonly fetch: FetchAdapter,
  ) {
    this.#baseUrl = assertLoopback(baseUrl)
    if (!validDesktopToken.test(token)) throw new Error("Agent core token must be a base64url credential")
    this.#authorization = `Basic ${Buffer.from(`${desktopUsername}:${token}`, "utf8").toString("base64")}`
  }

  async listChanges(): Promise<ChangeSummary[]> {
    const value = await this.request("desktop/changes", { method: "GET" })
    if (
      !Array.isArray(value) ||
      !value.every(
        (item) =>
          isRecord(item) &&
          typeof item.path === "string" &&
          typeof item.additions === "number" &&
          Number.isSafeInteger(item.additions) &&
          item.additions >= 0 &&
          typeof item.deletions === "number" &&
          Number.isSafeInteger(item.deletions) &&
          item.deletions >= 0 &&
          typeof item.status === "string",
      )
    ) {
      throw new Error("Agent core returned invalid changes")
    }
    return value as ChangeSummary[]
  }

  async readDiff(input: ReadDiffInput): Promise<string> {
    const query = new URLSearchParams({ source: input.source })
    if (input.path !== undefined) query.set("path", input.path)
    const value = await this.request(`desktop/diff?${query}`, { method: "GET" })
    if (!isRecord(value) || typeof value.diff !== "string") throw new Error("Agent core returned an invalid diff")
    return value.diff
  }

  async startTask(input: StartTaskInput): Promise<StartedTask> {
    const value = await this.request("desktop/tasks", this.jsonRequest("POST", input))
    if (!isRecord(value) || !validTaskId(value.taskId)) {
      throw new Error("Agent core returned an invalid task")
    }
    return { taskId: value.taskId }
  }

  async getTask(input: GetTaskInput): Promise<TaskDetails> {
    const value = await this.request(`desktop/tasks/${encodeURIComponent(input.taskId)}`, { method: "GET" })
    if (
      !isRecord(value) ||
      !validTaskId(value.taskId) ||
      value.taskId !== input.taskId ||
      !taskStatuses.has(value.status as TaskStatus)
    ) {
      throw new Error("Agent core returned an invalid task status")
    }
    return { taskId: value.taskId, status: value.status as TaskStatus }
  }

  async cancelTask(input: CancelTaskInput): Promise<void> {
    await this.request(`desktop/tasks/${encodeURIComponent(input.taskId)}/cancel`, this.jsonRequest("POST", {}))
  }

  private jsonRequest(method: string, body: unknown): RequestInit {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  }

  private async request(route: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers)
    headers.set("authorization", this.#authorization)
    const response = await this.fetch(new URL(route, this.#baseUrl).toString(), {
      ...init,
      headers,
      redirect: "error",
    })
    if (!response.ok) throw new Error(`Agent core request failed (${response.status})`)
    return response.json()
  }
}
