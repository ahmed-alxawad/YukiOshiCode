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
import { mergeEnv, planSpawn } from "./spawn"
import { Redact } from "@yukioshi/core/redact"
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

export interface KillDeps {
  platform?: NodeJS.Platform
  spawnFn?: typeof spawn
}

/**
 * Kill a process and its entire process tree cleanly. `child.killed` only says a signal was sent to the
 * leader, not that its descendants are gone, so it is not a reason to skip the tree kill.
 */
export async function killProcessTree(child: ChildProcess, deps: KillDeps = {}): Promise<void> {
  const pid = child.pid
  if (!pid) return

  if ((deps.platform ?? process.platform) === "win32") {
    // Asynchronous: a synchronous taskkill would freeze the whole event loop while it runs.
    await new Promise<void>((resolve) => {
      try {
        const killer = (deps.spawnFn ?? spawn)("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        })
        const timer = setTimeout(resolve, 5_000)
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        killer.once("error", done)
        killer.once("close", done)
      } catch {
        resolve()
      }
    })
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

const SECRET_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE_KEY|API_?KEY|ACCESS_?KEY|SESSION_?KEY|AUTH)$|^(?:AWS|AZURE|GCP|GOOGLE_APPLICATION)_|^NPM_CONFIG_.*AUTH|^(?:DOCKER|REGISTRY)_.*(?:PASS|TOKEN)/

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
    // Anything that looks like a credential, whoever it belongs to, and the ssh agent socket. A delegated
    // agent signs in with its own login; if it needs another variable, the agent's `env` setting passes it.
    if (SECRET_NAME.test(upper) || upper === "SSH_AUTH_SOCK" || upper === "DATABASE_URL") continue
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
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path "${targetPath}" resolves outside project directory "${cwd}".`)
  }
  return resolved
}

/**
 * Like assertInCwd, and also follows symbolic links: a link inside the project that points elsewhere (a
 * repository can contain one) must not let the delegated agent read or write outside the project.
 */
export async function resolveInCwd(targetPath: string, cwd: string): Promise<string> {
  const resolved = assertInCwd(targetPath, cwd)
  const root = await fs.promises.realpath(cwd).catch(() => path.resolve(cwd))
  let existing = resolved
  for (;;) {
    const real = await fs.promises.realpath(existing).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
      throw error
    })
    if (real !== undefined) {
      const rel = path.relative(root, real)
      if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
        throw new Error(`Path "${targetPath}" resolves outside project directory "${cwd}" through a link.`)
      return resolved
    }
    const parent = path.dirname(existing)
    if (parent === existing) return resolved
    existing = parent
  }
}

// What the agent wrote on stderr ends up in an error the model reads: mask secrets and keep it short.
function shownStderr(text: string) {
  const masked = Redact.mask(text.trim())
  return masked.length > 1_000 ? `${masked.slice(0, 1_000)}…` : masked
}

const READ_MAX = 10 * 1024 * 1024
const STDERR_MAX = 64 * 1024

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

  const platform = process.platform
  const env = mergeEnv(platform, sanitizeDelegateEnv(process.env), agentConfig.env ?? {})
  const plan = planSpawn(cmd, args, { platform, env, cwd, exists: (file) => fs.existsSync(file) })

  let child: ChildProcess
  try {
    child = spawn(plan.command, plan.args, {
      cwd,
      env,
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      windowsHide: true,
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
    if (stderrBuffer.length < STDERR_MAX) stderrBuffer += chunk.toString()
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
        const stderr = shownStderr(stderrBuffer)
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
        const fullPath = await resolveInCwd(params.path, cwd)
        filesChanged.add(params.path)
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true })
        await fs.promises.writeFile(fullPath, params.content, "utf-8")
      }
      return {}
    },

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const fullPath = await resolveInCwd(params.path, cwd)
      const size = (await fs.promises.stat(fullPath)).size
      if (size > READ_MAX) throw new Error(`"${params.path}" is too large to read (${size} bytes, limit ${READ_MAX}).`)
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
      const stderr = shownStderr(stderrBuffer)
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
