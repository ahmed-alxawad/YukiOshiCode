import { AgentCoreClient, type FetchAdapter } from "./agent-client"
import { startAgentProcess, type AgentProcess, type AgentProcessOptions } from "./agent-process"
import type { CancelTaskInput, GetTaskInput, ReadDiffInput, StartTaskInput } from "./contracts"

type StartProcess = (options: AgentProcessOptions) => Promise<AgentProcess>

export class ManagedAgent {
  #process: AgentProcess | undefined
  #client: AgentCoreClient | undefined

  constructor(
    private readonly executable: string,
    private readonly fetch: FetchAdapter,
    private readonly start: StartProcess = startAgentProcess,
  ) {}

  async selectWorkspace(workspace: string): Promise<void> {
    this.dispose()
    const process = await this.start({ executable: this.executable, workspace })
    this.#process = process
    this.#client = new AgentCoreClient(process.baseUrl, process.token, this.fetch)
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
    this.#process?.dispose()
    this.#process = undefined
    this.#client = undefined
  }

  private client(): AgentCoreClient {
    if (!this.#client) throw new Error("Select a workspace before using the agent core")
    return this.#client
  }
}
