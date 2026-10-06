import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import path from "path"
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type PermissionOption,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
  type ToolCallUpdate,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
} from "@agentclientprotocol/sdk"
import { InstallationVersion } from "@yukioshi/core/installation/version"
import { DEFAULT_TIMEOUT, type Agent as ConfigAgent } from "@yukioshi/core/v1/config/delegate"

export interface DelegateRunOptions {
  agentName: string
  agentConfig: ConfigAgent
  prompt: string
  cwd: string
  abortSignal: AbortSignal
  onProgress?: (title: string, metadata?: Record<string, unknown>) => void
  askPermission: (
    toolCall: ToolCallUpdate,
    options: PermissionOption[],
  ) => Promise<RequestPermissionOutcome>
}

export interface DelegateRunResult {
  finalMessage: string
  filesChanged: string[]
  stopReason: StopReason
}

/**
 * Kill a process and its entire process tree cleanly.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || child.killed) return

  const isWin = process.platform === "win32"
  if (isWin) {
    try {
      const { spawnSync } = await import("child_process")
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    } catch {}
    return
  }

  // POSIX: Kill process group
  try {
    process.kill(-pid, "SIGTERM")
  } catch (err: any) {
    if (err.code !== "ESRCH") {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
    }
  }

  // Allow brief grace period for cleanup, then SIGKILL if still alive
  await new Promise((resolve) => setTimeout(resolve, 300))

  try {
    process.kill(-pid, "SIGKILL")
  } catch (err: any) {
    if (err.code !== "ESRCH") {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
}

export function sanitizeDelegateEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (
      upper.endsWith("_API_KEY") ||
      upper.endsWith("_API_TOKEN") ||
      upper.endsWith("_SECRET_KEY") ||
      upper.endsWith("_ACCESS_TOKEN")
    ) {
      continue
    }
    if (upper === "GITHUB_TOKEN" || upper === "GH_TOKEN" || upper === "GIT_TOKEN") continue
    if (upper.startsWith("YUKIOSHI_")) continue
    if (
      upper.startsWith("ANTHROPIC_") ||
      upper.startsWith("OPENAI_") ||
      upper.startsWith("GEMINI_") ||
      upper.startsWith("GOOGLE_API") ||
      upper.startsWith("DEEPSEEK_") ||
      upper.startsWith("MISTRAL_") ||
      upper.startsWith("GROQ_") ||
      upper.startsWith("COHERE_") ||
      upper.startsWith("TOGETHER_") ||
      upper.startsWith("OPENROUTER_") ||
      upper.startsWith("AWS_SECRET")
    ) {
      continue
    }
    result[key] = value
  }
  return result
}

export function assertInCwd(targetPath: string, cwd: string): string {
  if (!targetPath) throw new Error("Path cannot be empty.")
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath)
  const rel = path.relative(cwd, resolved)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${targetPath}" resolves outside project directory "${cwd}".`)
  }
  return resolved
}

/**
 * Run a delegated task to an external coding agent over ACP.
 */
export async function runDelegate(options: DelegateRunOptions): Promise<DelegateRunResult> {
  const {
    agentName,
    agentConfig,
    prompt,
    cwd,
    abortSignal,
    onProgress,
    askPermission,
  } = options

  if (!agentConfig.command || agentConfig.command.length === 0) {
    throw new Error(`Agent "${agentName}" has no command configured.`)
  }

  const [cmd, ...args] = agentConfig.command

  const env = {
    ...sanitizeDelegateEnv(process.env),
    ...(agentConfig.env ?? {}),
  }

  let child: ChildProcess
  try {
    child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Agent "${agentName}" failed to start: command "${cmd}" was not found (ENOENT). Ensure "${cmd}" is installed and available in PATH.`,
      )
    }
    throw new Error(`Agent "${agentName}" failed to spawn: ${err.message}`)
  }

  let stderrBuffer = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString()
  })

  // Watch for startup failure before connection establishes
  let earlyExitError: Error | null = null
  let exited = false

  const exitPromise = new Promise<never>((_, reject) => {
    child.on("error", (err: any) => {
      exited = true
      if (err.code === "ENOENT") {
        earlyExitError = new Error(
          `Agent "${agentName}" failed to start: command "${cmd}" was not found. Ensure "${cmd}" is installed and available in PATH.`,
        )
      } else {
        earlyExitError = new Error(`Agent "${agentName}" failed with error: ${err.message}`)
      }
      reject(earlyExitError)
    })

    const handleTermination = (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true
      if (!earlyExitError) {
        const stderr = stderrBuffer.trim()
        const isAuthError =
          /auth|login|unauthenticated|not logged in|api[ _-]?key|token/i.test(stderr)
        if (isAuthError) {
          earlyExitError = new Error(
            `Agent "${agentName}" is not logged in: ${stderr}. Please log in first using "${agentName} login" (or the appropriate login command) or provide required credentials in your configuration.`,
          )
        } else {
          earlyExitError = new Error(
            `Agent "${agentName}" exited unexpectedly with code ${code ?? signal}: ${stderr || "process terminated"}. Check the agent configuration and installation.`,
          )
        }
      }
      reject(earlyExitError)
    }

    child.on("exit", (code, signal) => handleTermination(code, signal))
    child.on("close", (code, signal) => handleTermination(code, signal))
  })

  if (!child.stdin || !child.stdout) {
    killProcessTree(child)
    throw new Error(`Agent "${agentName}" process stdin/stdout streams are unavailable.`)
  }

  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        if (child.stdin?.destroyed || !child.stdin?.writable) {
          return resolve()
        }
        child.stdin?.write(chunk, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
    close() {
      child.stdin?.end()
    },
  })

  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout?.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      child.stdout?.on("end", () => {
        try {
          controller.close()
        } catch {}
      })
      child.stdout?.on("error", (err) => {
        try {
          controller.error(err)
        } catch {}
      })
    },
  })

  const stream = ndJsonStream(input, output)

  let finalMessage = ""
  const filesChanged = new Set<string>()

  const client: Client = {
    async sessionUpdate(params: SessionNotification) {
      const update = params.update
      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content.type === "text") {
          finalMessage += update.content.text
          onProgress?.(`Delegate (${agentName}): working...`, { currentText: finalMessage })
        }
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        onProgress?.(`Delegate (${agentName}): thinking...`)
      } else if (update.sessionUpdate === "tool_call") {
        const title = update.title || update.kind || "running tool"
        onProgress?.(`Delegate (${agentName}): ${title}`, { toolCall: update })
        if (update.locations) {
          for (const loc of update.locations) {
            if (loc.path) filesChanged.add(loc.path)
          }
        }
      } else if (update.sessionUpdate === "tool_call_update") {
        if (update.locations) {
          for (const loc of update.locations) {
            if (loc.path) filesChanged.add(loc.path)
          }
        }
        if (update.title) {
          onProgress?.(`Delegate (${agentName}): ${update.title}`, { toolCall: update })
        }
      } else if (update.sessionUpdate === "plan") {
        onProgress?.(`Delegate (${agentName}): plan updated`, { plan: update })
      }
    },

    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const outcome = await askPermission(params.toolCall, params.options)
      return { outcome }
    },

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      if (params.path) {
        const fullPath = assertInCwd(params.path, cwd)
        filesChanged.add(params.path)
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true })
        await fs.promises.writeFile(fullPath, params.content, "utf-8")
      }
      return {}
    },

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const fullPath = assertInCwd(params.path, cwd)
      const content = await fs.promises.readFile(fullPath, "utf-8")
      return { content }
    },
  }

  const connection = new ClientSideConnection(() => client, stream)

  let activeSessionId: string | null = null

  // Timeout handling
  const timeoutMs = agentConfig.timeout ?? DEFAULT_TIMEOUT
  let timeoutTimer: NodeJS.Timeout | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      reject(new Error(`Delegation to "${agentName}" timed out after ${timeoutMs}ms.`))
    }, timeoutMs)
  })

  // Turn abort handling
  const abortPromise = new Promise<never>((_, reject) => {
    if (abortSignal.aborted) {
      reject(new Error("Delegation aborted."))
      return
    }
    abortSignal.addEventListener(
      "abort",
      () => {
        reject(new Error("Delegation aborted."))
      },
      { once: true },
    )
  })

  try {
    // Race initialize against early exit / abort / timeout
    const initPromise = connection.initialize({
      protocolVersion: 1,
      clientInfo: {
        name: "yukioshi",
        version: InstallationVersion,
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    })

    await Promise.race([initPromise, exitPromise, abortPromise, timeoutPromise])

    // Create session
    const sessionPromise = connection.newSession({
      cwd,
      mcpServers: [],
    })
    const sessionResponse = await Promise.race([sessionPromise, exitPromise, abortPromise, timeoutPromise])
    activeSessionId = sessionResponse.sessionId

    onProgress?.(`Delegate (${agentName}): session started`, { sessionId: activeSessionId })

    // Send prompt
    const promptPromise = connection.prompt({
      sessionId: activeSessionId,
      prompt: [{ type: "text", text: prompt }],
    })

    const promptResponse = await Promise.race([promptPromise, exitPromise, abortPromise, timeoutPromise])

    return {
      finalMessage,
      filesChanged: Array.from(filesChanged),
      stopReason: promptResponse.stopReason,
    }
  } catch (err: any) {
    if (earlyExitError) {
      throw earlyExitError
    }
    if (err.message?.includes("closed") || err.message?.includes("connection") || exited) {
      if (!earlyExitError && (!exited || stderrBuffer.length === 0)) {
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      if (earlyExitError) {
        throw earlyExitError
      }
      const stderr = stderrBuffer.trim()
      const isAuthError = /auth|login|unauthenticated|not logged in|api[ _-]?key|token/i.test(stderr)
      if (isAuthError) {
        throw new Error(
          `Agent "${agentName}" is not logged in: ${stderr}. Please log in first using "${agentName} login" (or the appropriate login command) or provide required credentials in your configuration.`,
        )
      }
      if (exited) {
        throw new Error(
          `Agent "${agentName}" exited unexpectedly with code ${child.exitCode}: ${stderr || "process terminated"}. Check the agent configuration and installation.`,
        )
      }
    }

    // If turn was aborted or timed out, attempt ACP cancel then kill process
    if (activeSessionId && (abortSignal.aborted || err.message?.includes("timed out"))) {
      try {
        await Promise.race([
          connection.cancel({ sessionId: activeSessionId }),
          new Promise((resolve) => setTimeout(resolve, 800)),
        ])
      } catch {}
    }
    throw err
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    await killProcessTree(child)
  }
}
