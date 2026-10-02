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
  if (process.env.YUKIOSHI_VERIFY_COMMAND) {
    const parts = process.env.YUKIOSHI_VERIFY_COMMAND.trim().split(/\s+/)
    return [
      {
        kind: "test",
        label: process.env.YUKIOSHI_VERIFY_COMMAND.trim(),
        command: parts[0],
        args: parts.slice(1),
      },
    ]
  }

  const commands: ProjectCommandInput[] = []

  // Check explicit environment overrides first
  if (process.env.YUKIOSHI_VERIFY_TEST_CMD) {
    const parts = process.env.YUKIOSHI_VERIFY_TEST_CMD.trim().split(/\s+/)
    commands.push({
      kind: "test",
      label: process.env.YUKIOSHI_VERIFY_TEST_CMD.trim(),
      command: parts[0],
      args: parts.slice(1),
    })
  }
  if (process.env.YUKIOSHI_VERIFY_TYPECHECK_CMD) {
    const parts = process.env.YUKIOSHI_VERIFY_TYPECHECK_CMD.trim().split(/\s+/)
    commands.push({
      kind: "typecheck",
      label: process.env.YUKIOSHI_VERIFY_TYPECHECK_CMD.trim(),
      command: parts[0],
      args: parts.slice(1),
    })
  }
  if (process.env.YUKIOSHI_VERIFY_LINT_CMD) {
    const parts = process.env.YUKIOSHI_VERIFY_LINT_CMD.trim().split(/\s+/)
    commands.push({
      kind: "lint",
      label: process.env.YUKIOSHI_VERIFY_LINT_CMD.trim(),
      command: parts[0],
      args: parts.slice(1),
    })
  }

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
    fs.existsSync(pyproject) ||
    fs.existsSync(path.join(cwd, "pytest.ini")) ||
    fs.existsSync(path.join(cwd, "setup.py"))
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
  const userMsgID = promptResult?.data?.info?.parentID
  if (userMsgID && client.session?.diff) {
    try {
      const diffRes = await client.session.diff({ sessionID, messageID: userMsgID })
      if (diffRes && "data" in diffRes && Array.isArray(diffRes.data)) {
        for (const item of diffRes.data) {
          if (item?.file) diffFiles.push(item.file)
        }
      }
    } catch {}
  }

  // 2. Inspect parts returned in the promptResult / assistant message
  const inspectParts = (parts: any[]) => {
    for (const part of parts) {
      if (part.type === "patch" && Array.isArray(part.files)) {
        diffFiles.push(...part.files)
      }
      if (part.type === "tool" && part.state?.status === "completed") {
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

  // 3. Fallback: check session messages if diffFiles is still empty
  if (diffFiles.length === 0 && client.session?.messages) {
    try {
      const msgs = await client.session.messages({ sessionID })
      if (msgs && "data" in msgs && Array.isArray(msgs.data)) {
        for (const m of msgs.data) {
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

  // 4. Fallback: check git status in workspace for modified or newly added files
  if (diffFiles.length === 0) {
    try {
      const { execSync } = await import("node:child_process")
      const statusOut = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
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

    const proc = spawn(cmd.command ?? "", cmd.args ? [...cmd.args] : [], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill("SIGTERM")
      resolve({
        status: "failed",
        output: `Command timed out after ${timeoutMs}ms`,
        exitCode: 124,
        durationMs: Date.now() - started,
      })
    }, timeoutMs)

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 50_000) stdout += chunk.toString()
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 50_000) stderr += chunk.toString()
    })

    proc.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        status: "failed",
        output: err.message,
        exitCode: 1,
        durationMs: Date.now() - started,
      })
    })

    proc.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
export async function runVerificationPipeline(
  options: RunVerificationOptions,
): Promise<Verification.Summary> {
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
