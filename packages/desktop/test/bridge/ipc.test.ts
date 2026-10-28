import { describe, expect, test } from "bun:test"
import { AgentCoreClient } from "../../src/main/agent-client"
import { desktopChannels, type DesktopChannel } from "../../src/main/contracts"
import { registerDesktopIpc, type IpcHandler, type IpcRegistry } from "../../src/main/ipc"
import { WorkspaceService } from "../../src/main/workspace"

class Registry implements IpcRegistry {
  handlers = new Map<DesktopChannel, IpcHandler>()
  handle(channel: DesktopChannel, handler: IpcHandler) {
    this.handlers.set(channel, handler)
  }
}

const setup = () => {
  const registry = new Registry()
  const workspace = new WorkspaceService(
    { realpath: async (value) => value, readdir: async () => [], readFile: async () => "content" },
    { pickDirectory: async () => "/work/project" },
  )
  const agent = new AgentCoreClient("http://127.0.0.1:4096/", async () => ({
    ok: true,
    status: 200,
    json: async () => [],
  }))
  registerDesktopIpc(registry, { workspace, agent, allowedRendererOrigins: new Set(["app://kothora"]) })
  return registry
}

describe("desktop IPC", () => {
  test("rejects calls from an invalid renderer origin", async () => {
    const registry = setup()
    const handler = registry.handlers.get(desktopChannels.listWorkspaceFiles)!
    await expect(handler({ senderFrame: { url: "https://attacker.example/app" } })).rejects.toThrow("Untrusted")
  })

  test("validates payloads before dispatch", async () => {
    const registry = setup()
    const event = { senderFrame: { url: "app://kothora/index.html" } }
    await expect(registry.handlers.get(desktopChannels.readWorkspaceFile)!(event, { path: 1 })).rejects.toThrow("path")
    await expect(registry.handlers.get(desktopChannels.startTask)!(event, { prompt: "", extra: true })).rejects.toThrow(
      "prompt",
    )
    await expect(registry.handlers.get(desktopChannels.cancelTask)!(event, { taskId: "../../bad" })).rejects.toThrow(
      "Invalid",
    )
  })
})
