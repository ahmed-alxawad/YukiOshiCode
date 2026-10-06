import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk"

const mode = process.argv[2] ?? "normal"

if (process.env.MOCK_ACP_PID_FILE) {
  await Bun.write(process.env.MOCK_ACP_PID_FILE, String(process.pid))
}

if (mode === "auth-error") {
  console.error("Error: Not logged in. Please run 'agent login' first to authenticate.")
  process.exit(1)
}

if (mode === "hang") {
  // Hang indefinitely to test timeout
  await new Promise(() => {})
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  },
})

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) => {
      controller.enqueue(new Uint8Array(chunk))
    })
    process.stdin.on("end", () => controller.close())
    process.stdin.on("error", (err) => controller.error(err))
  },
})

const stream = ndJsonStream(input, output)

let agentConnection: AgentSideConnection

const agent: Agent = {
  async authenticate(): Promise<void> {},

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: {
        name: "mock-acp-agent",
        version: "1.0.0",
      },
    }
  },

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return {
      sessionId: "mock-session-001",
    }
  },

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionId = params.sessionId

    // 1. Report progress via message chunk
    await agentConnection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Listing files in directory:\n- file1.txt\n- file2.ts",
        },
      },
    })

    // 2. Report tool call affecting files
    await agentConnection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_list_01",
        title: "List files",
        locations: [{ path: "file1.txt" }, { path: "file2.ts" }],
      },
    })

    // 3. If mode is "write-file", write a file via ACP
    if (mode === "write-file") {
      await agentConnection.writeTextFile({
        sessionId,
        path: "created-by-agent.txt",
        content: "File content written over ACP",
      })
    }

    // 4. If mode is "with-permission", ask permission
    if (mode === "with-permission") {
      const permResult = await agentConnection.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: "tc_perm_01",
          title: "Run command",
        },
        options: [
          { optionId: "allow_1", kind: "allow_once", name: "Allow once" },
          { optionId: "deny_1", kind: "reject_once", name: "Deny" },
        ],
      })

      await agentConnection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\nPermission outcome: ${JSON.stringify(permResult.outcome)}`,
          },
        },
      })
    }

    if (mode === "sleep-during-prompt") {
      await new Promise((r) => setTimeout(r, 10000))
    }

    return {
      stopReason: "end_turn",
    }
  },

  async cancel(params: CancelNotification): Promise<void> {
    process.exit(0)
  },
}

agentConnection = new AgentSideConnection(() => agent, stream)
