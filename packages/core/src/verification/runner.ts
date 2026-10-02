import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Verification } from "@yukioshi/schema/verification"
import {
  VerificationEngine,
  planVerification,
  summarizeVerification,
  noChangesVerification,
  type FileChangeInput,
  type ProjectCommandInput,
  type PlannedCheck,
  type ToolExecutionResult,
} from "./index"

function splitCommandLine(value: string, variable: string): string[] {
  const result: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let started = false

  for (let index = 0; index < value.length; index++) {
    const char = value[index]

    if (quote) {
      if (char === quote) {
        quote = undefined
        started = true
        continue
      }
      if (char === "\\" && quote === '"' && ['"', "\\"].includes(value[index + 1] ?? "")) {
        current += value[++index]
        started = true
        continue
      }
      current += char
      started = true
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        result.push(current)
        current = ""
        started = false
      }
      continue
    }
    if (char === "\\" && /[\s'"\\]/.test(value[index + 1] ?? "")) {
      current += value[++index]
      started = true
      continue
    }
    current += char
    started = true
  }

  if (quote) throw new Error(`${variable} contains an unterminated ${quote} quote`)
  if (started) result.push(current)
  if (!result[0]) throw new Error(`${variable} must contain an executable command`)
  return result
}

function commandOverride(kind: ProjectCommandInput["kind"], variable: string): ProjectCommandInput | undefined {
  const value = process.env[variable]?.trim()
  if (!value) return undefined
  const [command, ...args] = splitCommandLine(value, variable)
  return { kind, label: value, command, args }
}

/** Minimal client contract needed for post-turn diff and message detection. */
export interface VerificationClient {
  readonly session?: {
    diff?(input: { sessionID: string; messageID?: string }): Promise<any>
    messages?(input: { sessionID: string; limit?: number }): Promise<any>
  }
}

/** Discovers how to test, lint, and type-check the project based on package/project metadata. */
export async function discoverProjectCommands(cwd: string): Promise<ProjectCommandInput[]> {
  // If a single full verify command override is provided, use it directly
  const verify = commandOverride("test", "YUKIOSHI_VERIFY_COMMAND")
  if (verify) return [verify]

  const commands: ProjectCommandInput[] = []

  // Check explicit environment overrides first
  const test = commandOverride("test", "YUKIOSHI_VERIFY_TEST_CMD")
  if (test) commands.push(test)
  const typecheck = commandOverride("typecheck", "YUKIOSHI_VERIFY_TYPECHECK_CMD")
  if (typecheck) commands.push(typecheck)
  const lint = commandOverride("lint", "YUKIOSHI_VERIFY_LINT_CMD")
  if (lint) commands.push(lint)

  // 1. Node / TypeScript / JavaScript ecosystem
  const pkgPath = path.join(cwd, "package.json")
  if (fs.existsSync(pkgPath)) {
    try {
      const content = fs.readFileSync(pkgPath, "utf8")
      const pkg = JSON.parse(content)
      const scripts = (pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, string>

      let pm = "npm"
      if (typeof pkg.packageManager === "string") {
        const name = pkg.packageManager.split("@")[0]
        if (["bun", "pnpm", "yarn", "npm"].includes(name)) pm = name
      } else if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) {
        pm = "bun"
      } else if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
        pm = "pnpm"
      } else if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
        pm = "yarn"
      }

      const scriptNames = Object.keys(scripts)
      const SCRIPT_KINDS: readonly [string, RegExp][] = [
        ["typecheck", /^(typecheck|type-check|check-types|types|tsc|check:types)$/],
        ["lint", /^(lint|lint:check|eslint)$/],
        ["test", /^(test|tests|test:unit|unit)$/],
      ]

      for (const [kind, regex] of SCRIPT_KINDS) {
        if (commands.some((c) => c.kind === kind)) continue
        const matched = scriptNames.find((name) => regex.test(name))
        if (matched) {
          const isTestCmd = kind === "test" && matched === "test"
          const args = isTestCmd && pm === "npm" ? ["test"] : ["run", matched]
          commands.push({
            kind,
            label: `${pm} ${args.join(" ")}`,
            command: pm,
            args,
          })
        }
      }

      // TypeScript fallback for typecheck if tsconfig exists
      if (!commands.some((c) => c.kind === "typecheck")) {
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
        if ("typescript" in deps && fs.existsSync(path.join(cwd, "tsconfig.json"))) {
          const tscBin = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc")
          if (fs.existsSync(tscBin)) {
            commands.push({
              kind: "typecheck",
              label: "tsc --noEmit",
              command: tscBin,
              args: ["--noEmit"],
            })
          }
        }
      }
    } catch {}
  }

  // 2. Python ecosystem
  const pyproject = path.join(cwd, "pyproject.toml")
  const hasPython =
    fs.existsSync(pyproject) || fs.existsSync(path.join(cwd, "pytest.ini")) || fs.existsSync(path.join(cwd, "setup.py"))
  if (hasPython) {
    const pythonBin = process.platform === "win32" ? "python" : "python3"
    if (!commands.some((c) => c.kind === "test")) {
      commands.push({
        kind: "test",
        label: "pytest",
        command: pythonBin,
        args: ["-m", "pytest", "-q"],
      })
    }
  }

  // 3. Rust ecosystem
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    if (!commands.some((c) => c.kind === "typecheck")) {
      commands.push({ kind: "typecheck", label: "cargo check", command: "cargo", args: ["check", "--quiet"] })
    }
    if (!commands.some((c) => c.kind === "test")) {
      commands.push({ kind: "test", label: "cargo test", command: "cargo", args: ["test", "--quiet"] })
    }
  }

  // 4. Go ecosystem
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    if (!commands.some((c) => c.kind === "test")) {
      commands.push({ kind: "test", label: "go test", command: "go", args: ["test", "./..."] })
    }
  }

  return commands
}

/** Detects changed files for the turn by checking session diffs, message parts, and git status. */
export async function detectTurnChangedFiles(
  client: VerificationClient,
  sessionID: string,
  promptResult?: any,
  cwd = process.cwd(),
): Promise<FileChangeInput[]> {
  const diffFiles: string[] = []

  // 1. Try querying session diff for the parent user message
  const promptInfo = promptResult?.data?.info ?? promptResult?.info ?? promptResult
  const assistantMsgID = typeof promptInfo?.id === "string" ? promptInfo.id : undefined
  const userMsgID = typeof promptInfo?.parentID === "string" ? promptInfo.parentID : undefined
  const readTurnDiff = async () => {
    if (!userMsgID || !client.session?.diff) return
    try {
      const diffRes = await client.session.diff({ sessionID, messageID: userMsgID })
      if (diffRes && "data" in diffRes && Array.isArray(diffRes.data)) {
        for (const item of diffRes.data) {
          if (item?.file) diffFiles.push(item.file)
        }
      }
    } catch {}
  }
  await readTurnDiff()

  // 2. Inspect parts returned in the promptResult / assistant message
  let sawCompletedTool = false
  const inspectParts = (parts: any[]) => {
    for (const part of parts) {
      if (part.type === "patch" && Array.isArray(part.files)) {
        diffFiles.push(...part.files)
      }
      if (part.type === "tool" && part.state?.status === "completed") {
        sawCompletedTool = true
        const input = part.state?.input
        const pathVal = input?.filePath ?? input?.path ?? input?.file
        if (typeof pathVal === "string" && ["edit", "write", "apply_patch"].includes(part.tool)) {
          diffFiles.push(pathVal)
        }
      }
    }
  }

  if (promptResult?.data?.parts && Array.isArray(promptResult.data.parts)) {
    inspectParts(promptResult.data.parts)
  } else if (promptResult?.parts && Array.isArray(promptResult.parts)) {
    inspectParts(promptResult.parts)
  }

  // Snapshot summaries are finalized asynchronously after the assistant turn.
  // The prompt response contains only the final assistant message, so inspect
  // this turn's full user/assistant pair to find tools used in earlier steps.
  // Briefly retry only when the current turn actually used a tool rather than
  // falling back to unrelated Git state.
  if (diffFiles.length === 0 && promptResult != null) {
    const inspectCurrentTurn = async () => {
      if (!client.session?.messages) return
      try {
        const response = await client.session.messages({ sessionID, limit: 20 })
        if (!response || !("data" in response) || !Array.isArray(response.data)) return
        for (const message of response.data) {
          const info = message?.info
          const isUser = userMsgID !== undefined && info?.id === userMsgID
          const isAssistant =
            (assistantMsgID !== undefined && info?.id === assistantMsgID) ||
            (userMsgID !== undefined && info?.role === "assistant" && info?.parentID === userMsgID)
          if (!isUser && !isAssistant) continue
          if (isUser && Array.isArray(info?.summary?.diffs)) {
            for (const diff of info.summary.diffs) {
              if (diff?.file) diffFiles.push(diff.file)
            }
          }
          if (isAssistant && Array.isArray(message.parts)) inspectParts(message.parts)
        }
      } catch {}
    }

    await inspectCurrentTurn()
    for (const delayMs of [25, 50, 100, 200, 250]) {
      if (diffFiles.length > 0 || !sawCompletedTool) break
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      await readTurnDiff()
      if (diffFiles.length > 0) break
      await inspectCurrentTurn()
    }
  }

  // 3. Without a concrete turn result, inspect only the latest assistant
  // message. Scanning the whole session replays old edits on every later turn.
  if (diffFiles.length === 0 && promptResult == null && client.session?.messages) {
    try {
      const msgs = await client.session.messages({ sessionID, limit: 1 })
      if (msgs && "data" in msgs && Array.isArray(msgs.data)) {
        const latest = msgs.data[0]
        if (latest) {
          const m = latest
          if (m.info?.summary?.diffs && Array.isArray(m.info.summary.diffs)) {
            for (const d of m.info.summary.diffs) {
              if (d.file) diffFiles.push(d.file)
            }
          }
          if (Array.isArray(m.parts)) {
            inspectParts(m.parts)
          }
        }
      }
    } catch {}
  }

  // 4. A whole-worktree fallback is useful only when there is no completed
  // turn to scope against. A concrete no-edit turn must remain a no-edit turn.
  if (diffFiles.length === 0 && promptResult == null) {
    try {
      const { execSync } = await import("node:child_process")
      const statusOut = execSync("git status --porcelain", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      for (const line of statusOut.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const file = trimmed.slice(2).trim()
        if (file) diffFiles.push(file)
      }
    } catch {}
  }

  // Normalize paths to be relative to cwd
  const normalized = diffFiles
    .filter(Boolean)
    .map((p) => (path.isAbsolute(p) ? path.relative(cwd, p) : p))
    .filter((p) => !p.startsWith("..") && !path.isAbsolute(p))

  const unique = Array.from(new Set(normalized))
  return unique.map((p) => ({ path: p, kind: "modified" }))
}

/** Executes an external command as a verification tool check. */
export async function executeVerificationCommand(
  cmd: ProjectCommandInput,
  cwd: string,
  timeoutMs = 60_000,
): Promise<ToolExecutionResult> {
  const started = Date.now()
  return new Promise<ToolExecutionResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutResolutionTimer: ReturnType<typeof setTimeout> | undefined

    const proc = spawn(cmd.command ?? "", cmd.args ? [...cmd.args] : [], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      // A separate POSIX process group lets timeout cleanup reach test-runner
      // workers as well as the package-manager process we launched directly.
      detached: process.platform !== "win32",
    })

    const signalTree = (signal: "SIGTERM" | "SIGKILL") => {
      if (!proc.pid) return
      if (process.platform === "win32") {
        if (signal !== "SIGKILL") return
        const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        })
        killer.on("error", () => {})
        return
      }
      try {
        process.kill(-proc.pid, signal)
      } catch {
        try {
          proc.kill(signal)
        } catch {}
      }
    }

    const resolveTimeout = () => {
      if (settled) return
      settled = true
      resolve({
        status: "failed",
        output: `Command timed out after ${timeoutMs}ms`,
        exitCode: 124,
        durationMs: Date.now() - started,
      })
    }

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      signalTree("SIGTERM")
      forceKillTimer = setTimeout(() => signalTree("SIGKILL"), process.platform === "win32" ? 0 : 250)
      // Do not report completion before the forced tree-kill phase. A direct
      // child can close while a detached worker continues running.
      timeoutResolutionTimer = setTimeout(resolveTimeout, process.platform === "win32" ? 500 : 350)
    }, timeoutMs)

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 50_000) stdout += chunk.toString()
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 50_000) stderr += chunk.toString()
    })

    proc.on("error", (err) => {
      if (settled || timedOut) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (timeoutResolutionTimer) clearTimeout(timeoutResolutionTimer)
      resolve({
        status: "failed",
        output: err.message,
        exitCode: 1,
        durationMs: Date.now() - started,
      })
    })

    proc.on("close", (code) => {
      if (settled || timedOut) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (timeoutResolutionTimer) clearTimeout(timeoutResolutionTimer)
      const output = (stdout + "\n" + stderr).trim()
      resolve({
        status: code === 0 ? "success" : "failed",
        output,
        exitCode: code ?? (code === null ? 1 : 0),
        durationMs: Date.now() - started,
      })
    })
  })
}

export interface RunVerificationOptions {
  readonly cwd: string
  readonly client: VerificationClient
  readonly sessionID: string
  readonly promptResult?: any
  readonly skip?: boolean
  readonly commandsOverride?: readonly ProjectCommandInput[]
  readonly changedFilesOverride?: readonly FileChangeInput[]
  readonly onStart?: (planned: readonly PlannedCheck[]) => void
  readonly onCheck?: (check: Verification.Check) => void
}

/**
 * Executes the core verification pipeline:
 * 1. Checks skip flag
 * 2. Detects changed files
 * 3. Discovers project commands
 * 4. Plans checks
 * 5. Runs the verification engine
 * 6. Returns the derived Verification.Summary
 */
export async function runVerificationPipeline(options: RunVerificationOptions): Promise<Verification.Summary> {
  if (
    options.skip ||
    process.env.YUKIOSHI_SKIP_VERIFY === "1" ||
    process.env.YUKIOSHI_SKIP_VERIFY === "true" ||
    process.env.YUKIOSHI_SKIP_VERIFY === "1"
  ) {
    return {
      status: "SKIPPED_BY_USER",
      checks: [],
      explanation: "Verification was skipped at your request.",
    }
  }

  // Detect changed files
  const changedFiles =
    options.changedFilesOverride ??
    (await detectTurnChangedFiles(options.client, options.sessionID, options.promptResult, options.cwd))

  if (changedFiles.length === 0) {
    return noChangesVerification()
  }

  // Discover project commands
  const commands = options.commandsOverride ?? (await discoverProjectCommands(options.cwd))

  // Plan verification
  const planned = planVerification(changedFiles, commands, false)
  if (planned.length === 0) {
    return summarizeVerification([])
  }

  options.onStart?.(planned)

  const engine = new VerificationEngine({
    commands,
    readFile: async (relativePath: string) => {
      try {
        return await fs.promises.readFile(path.resolve(options.cwd, relativePath), "utf8")
      } catch {
        return undefined
      }
    },
    runTool: async (name: string) => {
      let kind = ""
      if (name === "run_typecheck") kind = "typecheck"
      else if (name === "run_lint") kind = "lint"
      else if (name === "run_tests") kind = "test"

      const targetCmd = commands.find((c) => c.kind === kind)
      if (!targetCmd || !targetCmd.command) {
        return {
          status: "failed",
          output: `No command configured for ${name}`,
          durationMs: 0,
        }
      }
      return executeVerificationCommand(targetCmd, options.cwd)
    },
    onCheck: options.onCheck,
  })

  return engine.verify(changedFiles)
}
