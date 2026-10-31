import { randomBytes } from "node:crypto"
import { realpath } from "node:fs/promises"
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process"

const READY_LINE_LIMIT = 4096
const DEFAULT_TIMEOUT_MS = 10_000

type SpawnAgent = (
  executable: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    shell: false
    stdio: readonly ["ignore", "pipe", "ignore"]
    windowsHide: true
  },
) => Pick<ChildProcessWithoutNullStreams, "stdout" | "once" | "removeListener" | "kill">

export interface AgentProcessOptions {
  executable: string
  workspace: string
  timeoutMs?: number
  spawn?: SpawnAgent
  random?: (size: number) => Uint8Array
  canonicalize?: (path: string) => Promise<string>
}

export interface AgentProcess {
  baseUrl: string
  token: string
  dispose(): void
}

const parseReady = (line: string) => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("Agent core returned an invalid ready message")
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).type !== "ready" ||
    (value as Record<string, unknown>).hostname !== "127.0.0.1" ||
    !Number.isSafeInteger((value as Record<string, unknown>).port) ||
    ((value as Record<string, unknown>).port as number) < 1 ||
    ((value as Record<string, unknown>).port as number) > 65_535
  ) {
    throw new Error("Agent core returned an invalid ready message")
  }
  return (value as { port: number }).port
}

export async function startAgentProcess(options: AgentProcessOptions): Promise<AgentProcess> {
  const canonicalWorkspace = await (options.canonicalize ?? realpath)(options.workspace)
  const token = Buffer.from((options.random ?? randomBytes)(32)).toString("base64url")
  const spawnAgent = options.spawn ?? (nodeSpawn as unknown as SpawnAgent)
  const child = spawnAgent(options.executable, ["desktop-api", canonicalWorkspace], {
    env: { ...process.env, KOTHORA_DESKTOP_TOKEN: token },
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    child.kill()
  }

  try {
    const port = await new Promise<number>((resolve, reject) => {
      let buffered = ""
      const finish = (error?: Error, port?: number) => {
        clearTimeout(timer)
        child.stdout.removeListener("data", onData)
        child.removeListener("error", onError)
        child.removeListener("exit", onExit)
        if (error) reject(error)
        else resolve(port!)
      }
      const onData = (chunk: Buffer | string) => {
        buffered += chunk.toString()
        if (Buffer.byteLength(buffered) > READY_LINE_LIMIT) {
          finish(new Error("Agent core ready message exceeded the size limit"))
          return
        }
        const newline = buffered.indexOf("\n")
        if (newline < 0) return
        try {
          finish(undefined, parseReady(buffered.slice(0, newline)))
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Agent core returned an invalid ready message"))
        }
      }
      const onError = () => finish(new Error("Agent core failed to start"))
      const onExit = () => finish(new Error("Agent core exited before it was ready"))
      const timer = setTimeout(() => finish(new Error("Agent core startup timed out")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      child.stdout.on("data", onData)
      child.once("error", onError)
      child.once("exit", onExit)
    })
    // The core may emit operational logs after readiness. Keep draining stdout so
    // its pipe cannot fill and stall the long-running child process.
    child.stdout.on("data", () => undefined)
    return { baseUrl: `http://127.0.0.1:${port}/`, token, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
