import { AgentCoreClient, type FetchAdapter } from "./agent-client"
import { startAgentProcess, type AgentProcess, type AgentProcessOptions } from "./agent-process"
import type { CancelTaskInput, GetTaskInput, ReadDiffInput, StartTaskInput } from "./contracts"

type StartProcess = (options: AgentProcessOptions) => Promise<AgentProcess>

export class ManagedAgent {
  #process: AgentProcess | undefined
  #client: AgentCoreClient | undefined
  #generation = 0

  constructor(
    private readonly executable: string,
    private readonly fetch: FetchAdapter,
    private readonly start: StartProcess = startAgentProcess,
  ) {}

  async selectWorkspace(workspace: string): Promise<void> {
    this.dispose()
    const generation = this.#generation
    const process = await this.start({ executable: this.executable, workspace })
    if (generation !== this.#generation) {
      process.dispose()
      return
    }
    try {
      this.#client = new AgentCoreClient(process.baseUrl, process.token, this.fetch)
      this.#process = process
    } catch (error) {
      process.dispose()
      throw error
    }
  }

  async listChanges() {
    return this.client().listChanges()
  }

  async readDiff(input: ReadDiffInput) {
    return this.client().readDiff(input)
  }

  async startTask(input: StartTaskInput) {
    return this.client().startTask(input)
  }

  async getTask(input: GetTaskInput) {
    return this.client().getTask(input)
  }

  async cancelTask(input: CancelTaskInput) {
    return this.client().cancelTask(input)
  }

  dispose(): void {
    this.#generation += 1
    this.#process?.dispose()
    this.#process = undefined
    this.#client = undefined
  }

  private client(): AgentCoreClient {
    if (!this.#client) throw new Error("Select a workspace before using the agent core")
    return this.#client
  }
}
